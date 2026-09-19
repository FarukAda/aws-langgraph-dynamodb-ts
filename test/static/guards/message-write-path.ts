/**
 * The one file allowed to build a `Put` action inside the chat-history
 * adapter. Every message row is written by that file's transaction, which
 * carries the session-metadata update beside it — the property the delete side
 * pins on: the SESSION row's `writeId` changes **if and only if** a message row
 * was added.
 */
export const MESSAGE_PUT_OWNER = 'history/internal/message-transaction.ts';

/** A source file as this guard reads it: a repository-relative path and its text. */
export interface ScannedFile {
  path: string;
  text: string;
}

const PUT_ACTION = /(^|[^\w.])Put:\s*\{/;
const DIRECT_PUT = /\bclient\.put\(/;

/**
 * Files that would let a message row be written outside the transaction that
 * stamps the session's write id.
 *
 * Accepts: `files` — every source file, each with a `/`-separated path
 * relative to `src/`. Only those under `history/` are examined.
 *
 * Returns: one entry per offending file, naming which rule it broke. A unit
 * test asserting only "no offenders" cannot distinguish the two, so the reason
 * travels with the path.
 *
 * Throws: nothing.
 *
 * Guarantees: silent about every file outside `history/`, since the checkpointer
 * and the store carry their own per-write ids on the rows themselves and need
 * no such single writer.
 */
export function findMessageWritePathBreaks(files: readonly ScannedFile[]): string[] {
  const offenders: string[] = [];
  for (const { path, text } of files) {
    if (!path.startsWith('history/')) continue;
    if (DIRECT_PUT.test(text)) offenders.push(`${path}: writes a row with client.put`);
    if (path !== MESSAGE_PUT_OWNER && PUT_ACTION.test(text)) {
      offenders.push(`${path}: builds a Put action`);
    }
  }
  return offenders;
}
