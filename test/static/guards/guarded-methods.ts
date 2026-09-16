import { posix } from 'node:path';

import ts from 'typescript';

/** One public member whose body does not take the required guard shape. */
export interface UnguardedMethod {
  file: string;
  name: string;
}

/**
 * `shared/errors/boundary`, relative to `SRC_ROOT`, with no extension — the
 * only module `guardPublic`/`guardPublicIterable` may be imported from for a
 * call to count as guarded.
 */
const BOUNDARY_MODULE = 'shared/errors/boundary';

/** True when any modifier in `modifiers` is `kind`. */
function hasModifier(
  modifiers: readonly ts.ModifierLike[] | undefined,
  kind: ts.SyntaxKind,
): boolean {
  return (modifiers ?? []).some((m) => m.kind === kind);
}

/** True for a `private` member. */
function isPrivate(modifiers: readonly ts.ModifierLike[] | undefined): boolean {
  return hasModifier(modifiers, ts.SyntaxKind.PrivateKeyword);
}

/**
 * `specifier`, as written in an import inside `file`, resolved to a path
 * relative to `SRC_ROOT` — by path math alone, never the filesystem, so a
 * synthetic source resolves exactly as the real tree does. `undefined` for a
 * non-relative specifier, which this package never imports the boundary
 * through.
 */
function resolveSpecifier(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  return posix.normalize(posix.join(posix.dirname(file), specifier));
}

/**
 * The local names `source` binds to `guardPublic` or `guardPublicIterable`,
 * imported from the error boundary module — never by name alone. A local
 * function or a same-named import from anywhere else does not count: without
 * one of these bindings, nothing in the file can be guarded.
 */
function guardBindings(parsed: ts.SourceFile, file: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const node of parsed.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    if (resolveSpecifier(file, node.moduleSpecifier.text) !== BOUNDARY_MODULE) continue;
    const bindings = node.importClause?.namedBindings;
    if (node.importClause?.isTypeOnly === true) continue;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = (element.propertyName ?? element.name).text;
      if (imported === 'guardPublic' || imported === 'guardPublicIterable')
        names.add(element.name.text);
    }
  }
  return names;
}

/** Unwrap `expr` through parentheses, `as`, `satisfies`, `!` and `await`. */
function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAwaitExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/** True for a call to one of `guardNames`, however the expression is wrapped. */
function isGuardCall(expr: ts.Expression, guardNames: ReadonlySet<string>): boolean {
  const unwrapped = unwrap(expr);
  return (
    ts.isCallExpression(unwrapped) &&
    ts.isIdentifier(unwrapped.expression) &&
    guardNames.has(unwrapped.expression.text)
  );
}

/** True when `block`'s whole body is exactly one `return` of a guard call. */
function isGuardedBlock(block: ts.Block, guardNames: ReadonlySet<string>): boolean {
  if (block.statements.length !== 1) return false;
  const [statement] = block.statements;
  return (
    ts.isReturnStatement(statement) &&
    statement.expression !== undefined &&
    isGuardCall(statement.expression, guardNames)
  );
}

/**
 * True when a member carrying `modifiers` and declared return type `type`
 * must take the guard shape: it is `async`, its return type begins
 * `Promise<` or `AsyncGenerator<`, or it declares no return type at all while
 * not being `async` — a shape this syntactic check cannot otherwise prove
 * synchronous, so it is held to the same standard rather than let through.
 */
function needsGuardShape(
  modifiers: readonly ts.ModifierLike[] | undefined,
  type: ts.TypeNode | undefined,
): boolean {
  if (hasModifier(modifiers, ts.SyntaxKind.AsyncKeyword)) return true;
  if (type === undefined) return true;
  const typeText = type.getText();
  return typeText.startsWith('Promise<') || typeText.startsWith('AsyncGenerator<');
}

/** The gap a method leaves, or `undefined`. A bodyless overload signature is skipped. */
function methodGap(
  member: ts.MethodDeclaration,
  guardNames: ReadonlySet<string>,
): string | undefined {
  if (member.name === undefined || member.body === undefined) return undefined;
  const modifiers = ts.getModifiers(member);
  if (isPrivate(modifiers) || !needsGuardShape(modifiers, member.type)) return undefined;
  return isGuardedBlock(member.body, guardNames) ? undefined : member.name.getText();
}

/**
 * The gap a class field leaves, or `undefined`. Only a field initialised with
 * an arrow function or a function expression is in scope, and the trigger is
 * that function's own modifiers and return type, never the field's. A
 * concise arrow body must *be* the guard call; a block body follows the same
 * single-return rule as a method.
 */
function propertyGap(
  member: ts.PropertyDeclaration,
  guardNames: ReadonlySet<string>,
): string | undefined {
  if (member.name === undefined || member.initializer === undefined) return undefined;
  if (isPrivate(ts.getModifiers(member))) return undefined;
  const fn = member.initializer;
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return undefined;
  if (!needsGuardShape(ts.getModifiers(fn), fn.type)) return undefined;
  const guarded = ts.isBlock(fn.body)
    ? isGuardedBlock(fn.body, guardNames)
    : isGuardCall(fn.body, guardNames);
  return guarded ? undefined : member.name.getText();
}

/**
 * The gap a getter leaves, or `undefined`. A getter cannot carry `async`, so
 * it is swept into scope only when it declares a `Promise`/`AsyncGenerator`
 * return type itself — an ordinary getter with no such type is left alone.
 */
function getterGap(
  member: ts.GetAccessorDeclaration,
  guardNames: ReadonlySet<string>,
): string | undefined {
  if (member.name === undefined || member.body === undefined || member.type === undefined)
    return undefined;
  if (isPrivate(ts.getModifiers(member))) return undefined;
  const typeText = member.type.getText();
  if (!typeText.startsWith('Promise<') && !typeText.startsWith('AsyncGenerator<')) return undefined;
  return isGuardedBlock(member.body, guardNames) ? undefined : member.name.getText();
}

/** The gap one class member leaves, or `undefined` for a member kind not in scope. */
function memberGap(member: ts.ClassElement, guardNames: ReadonlySet<string>): string | undefined {
  if (ts.isMethodDeclaration(member)) return methodGap(member, guardNames);
  if (ts.isPropertyDeclaration(member)) return propertyGap(member, guardNames);
  if (ts.isGetAccessor(member)) return getterGap(member, guardNames);
  return undefined;
}

/**
 * The members of every class declared in `source` that must take the guard
 * shape and do not. `source` is treated as already in scope — deciding which
 * classes belong on the public API happens before a file reaches here; see
 * `public-classes.ts`.
 */
export function unguardedMethodsIn(source: string, file = 'source.ts'): UnguardedMethod[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const guardNames = guardBindings(parsed, file);
  const gaps: UnguardedMethod[] = [];
  for (const node of parsed.statements) {
    if (!ts.isClassDeclaration(node)) continue;
    const className = node.name?.text ?? 'default';
    for (const member of node.members) {
      const gap = memberGap(member, guardNames);
      if (gap !== undefined) gaps.push({ file, name: `${className}.${gap}` });
    }
  }
  return gaps;
}
