import * as ts from 'typescript';

/** True when any modifier in `modifiers` is `kind`. */
function hasModifier(
  modifiers: readonly ts.ModifierLike[] | undefined,
  kind: ts.SyntaxKind,
): boolean {
  return (modifiers ?? []).some((modifier) => modifier.kind === kind);
}

/** Whether `node` carries the `export` modifier. */
function isExported(node: ts.FunctionDeclaration): boolean {
  return hasModifier(node.modifiers, ts.SyntaxKind.ExportKeyword);
}

/**
 * Whether the `const`/`let`/`var` statement that declares `declaration`
 * carries the `export` modifier — the same "reachable from outside the
 * module" test {@link isExported} applies to a function declaration, for a
 * name bound to an arrow function or a function expression instead.
 */
function isExportedVariable(declaration: ts.VariableDeclaration): boolean {
  const statement = declaration.parent.parent;
  return (
    ts.isVariableStatement(statement) &&
    hasModifier(ts.getModifiers(statement), ts.SyntaxKind.ExportKeyword)
  );
}

/**
 * Whether a class method is reachable from outside its class: not `private`
 * or `protected`. This is the method-level analogue of {@link isExported}: a
 * `private`/`protected` method is a class's own internal helper, held to no
 * naming rule, the same way an unexported function is not.
 */
function isPublicMethod(member: ts.MethodDeclaration): boolean {
  const modifiers = ts.getModifiers(member);
  return (
    !hasModifier(modifiers, ts.SyntaxKind.PrivateKeyword) &&
    !hasModifier(modifiers, ts.SyntaxKind.ProtectedKeyword)
  );
}

/**
 * One breach of the naming convention at `at`, for something named `name`
 * and declaring return type `returns` (`undefined` when no annotation is
 * written): no `validate*`, checked or not; a `checked` `parse*` — exported,
 * or a public method — must declare a return type that is not `void`; a
 * `checked` `assert*` must declare `void`, `Promise<void>` or an `asserts`
 * predicate. `undefined` when `name`/`returns` obey the convention.
 */
function verbViolation(
  name: string,
  at: string,
  checked: boolean,
  returns: string | undefined,
): string | undefined {
  const returnsNothing = returns === 'void' || returns === 'Promise<void>';
  if (/^validate[A-Z]/.test(name)) {
    return `${at} — validate* is retired: a parse* returns the checked value, an assert* returns nothing`;
  }
  if (checked && /^parse[A-Z]/.test(name) && (returns === undefined || returnsNothing)) {
    return `${at} — a parse* function returns the value it checked, as a more precise type`;
  }
  if (
    checked &&
    /^assert[A-Z]/.test(name) &&
    !(returnsNothing || returns?.startsWith('asserts ') === true)
  ) {
    return `${at} — an assert* function returns nothing; one that returns the value is a parse*`;
  }
  return undefined;
}

/**
 * Every place in `source` that breaks the naming convention: no function,
 * `const` bound to an arrow function or a function expression, or class
 * method is named `validate*`; an exported `parse*` function or `const`, or a
 * public `parse*` method, declares a return type that is not `void`; an
 * exported `assert*` function or `const`, or a public `assert*` method,
 * declares `void`, `Promise<void>` or an `asserts` predicate. An unexported
 * function or `const`, and a `private`/`protected` method, are not
 * constrained beyond the `validate*` ban.
 */
export function namingViolations(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  const at = (node: ts.Node, name: string): string =>
    `${file}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}: ${name}`;
  const record = (violation: string | undefined): void => {
    if (violation !== undefined) violations.push(violation);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      const name = node.name.text;
      record(verbViolation(name, at(node, name), isExported(node), node.type?.getText(sourceFile)));
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      const name = node.name.text;
      record(
        verbViolation(
          name,
          at(node, name),
          isExportedVariable(node),
          node.initializer.type?.getText(sourceFile),
        ),
      );
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      record(
        verbViolation(name, at(node, name), isPublicMethod(node), node.type?.getText(sourceFile)),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}
