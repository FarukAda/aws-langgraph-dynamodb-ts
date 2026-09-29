import { posix } from 'node:path';

import ts from 'typescript';

import { withoutEmittedExtension } from './source-files';

/**
 * One public member, or one function, whose body does not take the required
 * guard shape. `name` is `Class.member` for a class member and the function's
 * own name for a function.
 */
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

/**
 * The declared return types that mark a member or a function as asynchronous:
 * a promise, or any of the async iterations a caller consumes with
 * `for await`. Matched as a prefix of the annotation's text.
 */
const ASYNC_RETURN_PREFIXES: readonly string[] = [
  'Promise<',
  'PromiseLike<',
  'AsyncGenerator<',
  'AsyncIterable<',
  'AsyncIterableIterator<',
];

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

/** True when the annotation `type` begins with one of {@link ASYNC_RETURN_PREFIXES}. */
function declaresAsyncReturn(type: ts.TypeNode): boolean {
  const typeText = type.getText();
  return ASYNC_RETURN_PREFIXES.some((prefix) => typeText.startsWith(prefix));
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
  return posix.normalize(posix.join(posix.dirname(file), withoutEmittedExtension(specifier)));
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
 * True when a member or a function carrying `modifiers` and declared return
 * type `type` must take the guard shape: it is `async`, its return type begins
 * with one of {@link ASYNC_RETURN_PREFIXES}, or it declares no return type at
 * all while not being `async` — a shape this syntactic check cannot otherwise
 * prove synchronous, so it is held to the same standard rather than let
 * through.
 *
 * Known limit: the check reads the annotation's text, not the type it
 * resolves to. A return type written through an alias of a promise
 * (`type Pending = Promise<void>`, then `run(): Pending`) is not recognised,
 * so a member or function declared that way is held to the rule only when it
 * is also `async`. Seeing through the alias needs the type checker, which this
 * guard does not run.
 */
function needsGuardShape(
  modifiers: readonly ts.ModifierLike[] | undefined,
  type: ts.TypeNode | undefined,
): boolean {
  if (hasModifier(modifiers, ts.SyntaxKind.AsyncKeyword)) return true;
  if (type === undefined) return true;
  return declaresAsyncReturn(type);
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
 * True when a function held in a value — a class field's or a variable's
 * initialiser — leaves a gap. Only an arrow function or a function expression
 * is in scope, and the trigger is that function's own modifiers and return
 * type, never the holder's. A concise arrow body must *be* the guard call; a
 * block body follows the same single-return rule as a method.
 */
function initializerGap(
  initializer: ts.Expression | undefined,
  guardNames: ReadonlySet<string>,
): boolean {
  if (initializer === undefined) return false;
  if (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer)) return false;
  if (!needsGuardShape(ts.getModifiers(initializer), initializer.type)) return false;
  const guarded = ts.isBlock(initializer.body)
    ? isGuardedBlock(initializer.body, guardNames)
    : isGuardCall(initializer.body, guardNames);
  return !guarded;
}

/** The gap a class field leaves, or `undefined`; see {@link initializerGap}. */
function propertyGap(
  member: ts.PropertyDeclaration,
  guardNames: ReadonlySet<string>,
): string | undefined {
  if (member.name === undefined || isPrivate(ts.getModifiers(member))) return undefined;
  return initializerGap(member.initializer, guardNames) ? member.name.getText() : undefined;
}

/**
 * The gap a getter leaves, or `undefined`. A getter cannot carry `async`, so
 * it is swept into scope only when it declares one of the
 * {@link ASYNC_RETURN_PREFIXES} return types itself — an ordinary getter with
 * no such type is left alone.
 */
function getterGap(
  member: ts.GetAccessorDeclaration,
  guardNames: ReadonlySet<string>,
): string | undefined {
  if (member.name === undefined || member.body === undefined || member.type === undefined)
    return undefined;
  if (isPrivate(ts.getModifiers(member))) return undefined;
  if (!declaresAsyncReturn(member.type)) return undefined;
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
 * The top-level functions one statement declares that must take the guard
 * shape and do not: a function declaration with a body — an overload
 * signature has none — or each variable the statement initialises with a
 * function, held to the rule {@link initializerGap} states.
 */
function functionGaps(node: ts.Statement, guardNames: ReadonlySet<string>): string[] {
  if (ts.isFunctionDeclaration(node)) {
    if (node.name === undefined || node.body === undefined) return [];
    if (!needsGuardShape(ts.getModifiers(node), node.type)) return [];
    return isGuardedBlock(node.body, guardNames) ? [] : [node.name.text];
  }
  if (!ts.isVariableStatement(node)) return [];
  return node.declarationList.declarations
    .filter((declaration) => initializerGap(declaration.initializer, guardNames))
    .map((declaration) => declaration.name.getText());
}

/**
 * The members of every class, and every top-level function, declared in
 * `source` that must take the guard shape and do not. `source` is treated as
 * already in scope — deciding which classes and functions belong on the
 * public API happens before a file reaches here; see
 * `public-declarations.ts`.
 */
export function unguardedMethodsIn(source: string, file = 'source.ts'): UnguardedMethod[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const guardNames = guardBindings(parsed, file);
  const gaps: UnguardedMethod[] = [];
  for (const node of parsed.statements) {
    for (const name of functionGaps(node, guardNames)) gaps.push({ file, name });
    if (!ts.isClassDeclaration(node)) continue;
    const className = node.name?.text ?? 'default';
    for (const member of node.members) {
      const gap = memberGap(member, guardNames);
      if (gap !== undefined) gaps.push({ file, name: `${className}.${gap}` });
    }
  }
  return gaps;
}
