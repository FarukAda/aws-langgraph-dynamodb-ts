import * as ts from 'typescript';

/**
 * The one file allowed to write a row inside the chat-history adapter. Every
 * message row is written by that file's transaction, which carries the
 * session-metadata update beside it — the property the delete side pins on:
 * the SESSION row's `writeId` changes **if and only if** a message row was
 * added.
 */
export const MESSAGE_PUT_OWNER = 'history/internal/message-transaction.ts';

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

/**
 * Files that would let a message row be written outside the transaction that
 * stamps the session's write id.
 *
 * Parses rather than greps, for the reason `line-count.ts` already gives: this
 * repository quotes expressions in its JSDoc constantly, and a textual scan
 * reports every such quotation as a write. It flags a `Put` or `PutRequest`
 * key in an object literal — whatever its value, so a hoisted action is caught
 * too — and any `.put(` call.
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
      if (ts.isPropertyAssignment(node) && path !== MESSAGE_PUT_OWNER) {
        const key = keyName(node.name);
        if (key !== undefined && WRITE_ACTIONS.includes(key)) {
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
