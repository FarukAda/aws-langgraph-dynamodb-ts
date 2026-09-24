import * as ts from 'typescript';

/**
 * The one file allowed to write a row inside the chat-history adapter: the
 * append. Every message row is written by that file's transaction, which
 * carries the session-metadata update beside it — the property the delete side
 * pins on: the SESSION row's `writeId` changes **if and only if** a message row
 * was added.
 */
export const MESSAGE_PUT_OWNER = 'history/internal/append.ts';

/**
 * The one function inside {@link MESSAGE_PUT_OWNER} allowed to build the
 * message `Put`. Naming the function, not just the file, is what makes a
 * second write path added elsewhere in that file — a much larger module now
 * that it also holds rollback and chunking — fail the same as one added to
 * any other file.
 */
export const MESSAGE_PUT_BUILDER = 'attempt';

/** A source file as this guard reads it: a repository-relative path and its text. */
export interface ScannedFile {
  path: string;
  text: string;
}

/** Object-literal keys that put a row on the table. */
const WRITE_ACTIONS: readonly string[] = ['Put', 'PutRequest'];

function keyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  return ts.isStringLiteral(name) ? name.text : undefined;
}

/** The name of the nearest enclosing named function declaration, or `undefined` outside one. */
function enclosingFunctionName(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isFunctionDeclaration(current) && current.name !== undefined) {
      return current.name.text;
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * Files that would let a message row be written outside the transaction that
 * stamps the session's write id.
 *
 * Parses rather than greps: this repository quotes expressions in its JSDoc
 * constantly, and a textual scan reports every such quotation as a write. It
 * flags a `Put` or `PutRequest`
 * key in an object literal — whatever its value, so a hoisted action is caught
 * too — and any `.put(` call. Inside {@link MESSAGE_PUT_OWNER} only
 * {@link MESSAGE_PUT_BUILDER} is exempt from the `Put`/`PutRequest` check, so a
 * second write path added elsewhere in that file — it now also holds rollback
 * and chunking — is flagged the same as one added to any other file.
 *
 * Accepts: `files` — every source file, each with a `/`-separated path
 * relative to `src/`. Only those under `history/` are examined.
 *
 * Returns: one entry per offending file, naming which rule it broke, because a
 * test asserting only "no offenders" cannot tell them apart.
 *
 * Throws: nothing.
 *
 * Guarantees: silent about every file outside `history/` — the checkpointer and
 * the store carry a per-write id on the rows themselves and need no single
 * writer. **What it does not cover**, and what a reviewer of a new write path
 * must check by hand: a generic row-writing helper added under `shared/` and
 * called from here, and an `UpdateItem` aimed at a message key, which creates
 * the row without any write action in this file.
 */
export function findMessageWritePathBreaks(files: readonly ScannedFile[]): string[] {
  const offenders: string[] = [];
  for (const { path, text } of files) {
    if (!path.startsWith('history/')) continue;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const seen = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node)) {
        const key = keyName(node.name);
        const exempt =
          path === MESSAGE_PUT_OWNER && enclosingFunctionName(node) === MESSAGE_PUT_BUILDER;
        if (key !== undefined && WRITE_ACTIONS.includes(key) && !exempt) {
          seen.add(`${path}: builds a ${key} action`);
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'put'
      ) {
        seen.add(`${path}: writes a row with .put`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    offenders.push(...[...seen].sort());
  }
  return offenders;
}
