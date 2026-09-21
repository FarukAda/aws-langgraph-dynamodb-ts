import * as ts from 'typescript';

/**
 * **The rule.** No `catch` block in this package may read the raw `message` of
 * the error it caught. It must quote `redactedMessage(error)` instead.
 *
 * An upstream message is attacker- and environment-shaped text this package
 * did not write. The AWS SDK's signing and credential failures quote the
 * credential they tried to sign with, so a wrapper that copies the message
 * verbatim puts `aws_secret_access_key=` and `x-amz-security-token=` on
 * `err.message` — a public field an application may print, log or return with
 * no redacting logger anywhere in the path. `redactedMessage` exists for
 * exactly that hand-off and costs a call; the two S3 offload sites that
 * skipped it were found by a survey rather than by a rule, which is what this
 * guard replaces.
 *
 * **Why a read, not an interpolation.** Flagging only `${error.message}` would
 * pass the same string reaching a constructor argument, a concatenation or a
 * log field, and the fix is identical in every case. A caught message has no
 * use this package needs it unredacted for: classifying a failure reads
 * `name`, `code` or `$metadata`, never the prose. So the whole read is
 * refused, and a future classification that genuinely needs the raw text is a
 * decision to record here rather than a diff that slips past.
 *
 * **What it cannot see.** The binding must be read directly. A message laundered
 * through a helper — `describe(error)` returning `error.message` from a
 * parameter — is invisible to a guard without type information, as is a read
 * after the error is assigned to another variable. Those are not the shape the
 * defect took; this catches the shape it did.
 */
export const RAW_MESSAGE_RULE =
  'a catch block must quote redactedMessage(error), not error.message';

/** A caught error's raw `message`, read in one source file at one line. */
export interface RawMessageRead {
  path: string;
  line: number;
}

/** The property this guard refuses to see read off a caught error. */
const MESSAGE = 'message';

/**
 * `expression` with every wrapper that does not change what is read removed:
 * parentheses, `as`, `satisfies`, `!` and an old-style type assertion. This is
 * what makes `(error as Error).message` and `error.message` one case, and the
 * cast form is the one the defect was written in.
 */
function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Whether `expression`, unwrapped, is the identifier `binding`. */
function isBinding(expression: ts.Expression, binding: string): boolean {
  const target = unwrap(expression);
  return ts.isIdentifier(target) && target.text === binding;
}

/** The name a `catch (error)` binds, or `undefined` for a pattern or no binding. */
function catchBinding(clause: ts.CatchClause): string | undefined {
  const name = clause.variableDeclaration?.name;
  return name !== undefined && ts.isIdentifier(name) ? name.text : undefined;
}

/**
 * Whether the clause destructures the message out of the error it catches —
 * `catch ({ message })`, which reads exactly what the rule refuses without ever
 * naming a binding to read it from.
 */
function destructuresMessage(clause: ts.CatchClause): boolean {
  const name = clause.variableDeclaration?.name;
  if (name === undefined || !ts.isObjectBindingPattern(name)) return false;
  return name.elements.some((element) => {
    const key = element.propertyName ?? element.name;
    return ts.isIdentifier(key) && key.text === MESSAGE;
  });
}

/** Whether `node` reads `.message` or `['message']` off `binding`. */
function readsMessageOf(node: ts.Node, binding: string): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text === MESSAGE && isBinding(node.expression, binding);
  }
  if (!ts.isElementAccessExpression(node)) return false;
  const key = node.argumentExpression;
  return ts.isStringLiteralLike(key) && key.text === MESSAGE && isBinding(node.expression, binding);
}

/**
 * The 1-based lines of `source` where a `catch` block reads the raw message of
 * the error it caught, in ascending order.
 *
 * Matched on the parsed tree, not as text, so a mention in a comment, a string
 * or an unrelated `.message` — a stored LangChain message, a parameter of a
 * helper — is not counted. A clause that destructures the message is reported
 * at the clause itself, which is where the read is written.
 */
export function findRawMessageReads(source: string): number[] {
  const file = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
  const lineOf = (node: ts.Node): number =>
    file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const lines = new Set<number>();
  const inspect = (node: ts.Node, binding: string): void => {
    if (readsMessageOf(node, binding)) lines.add(lineOf(node));
    ts.forEachChild(node, (child) => inspect(child, binding));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node)) {
      if (destructuresMessage(node)) lines.add(lineOf(node));
      const binding = catchBinding(node);
      if (binding !== undefined) inspect(node.block, binding);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...lines].sort((first, second) => first - second);
}

/** Every raw-message read in `files`, in the order the files were given. */
export function findRawMessageSites(
  files: readonly { path: string; text: string }[],
): RawMessageRead[] {
  return files.flatMap(({ path, text }) =>
    findRawMessageReads(text).map((line): RawMessageRead => ({ path, line })),
  );
}
