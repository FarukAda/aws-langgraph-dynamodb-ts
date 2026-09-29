/**
 * Hides that repairing `messageCount` is the session row's own job.
 *
 * The public repair only parses the session id and hands it to the module
 * that owns the count (record 22). The recount, the compare-and-swap on the
 * value it read, and the retry when an append lands in between all live
 * there, beside the append that keeps the count in step, so the repair and
 * the append cannot come to disagree about what the count means.
 */

import { parseSessionId } from '../internal/parse.js';
import { repairMessageCount } from '../internal/session.js';
import type { HistoryContext } from '../internal/setup.js';

/**
 * Recompute `messageCount` from the number of stored message items and write it
 * back, repairing drift. The append path keeps the count consistent
 * transactionally, so this is only needed after external corruption.
 *
 * **Safe to run on a live session.** The count is written under a condition on
 * the value the row held when the count was computed, so an append landing in
 * between makes the write fail rather than clobber the increment; the tool then
 * recounts and tries again. Writing it unconditionally — which is what this did
 * — silently discarded concurrent appends on exactly the sessions an operator
 * reaches for this tool to fix.
 *
 * Accepts: `sessionId` — validated, and an existing session: repairing one that
 * does not exist would mean creating it. `signal` — aborts the reads.
 *
 * Returns: the count now stored, which is the number of messages a reader would
 * see.
 *
 * Throws: `VALIDATION` naming `sessionId`; `CONDITION_CONFLICT` when the
 * session does not exist — rather than creating a permanent, TTL-less
 * metadata-only row — and when it stays too busy to settle within
 * {@link OVERWRITE_CAS_MAX_ATTEMPTS} attempts; `FORMAT_UNSUPPORTED` for a
 * message row a newer release wrote, and `VALIDATION` naming `message` for
 * a row in the session's message key space that this adapter did not write,
 * both of which `getMessages` refuses too — writing a count back for a session
 * no read can open would repair nothing; whatever the reads and the write
 * throw.
 *
 * Guarantees: safe on a live session. The write is pinned to the value the row
 * held when the count was computed, so an append landing in between fails the
 * write rather than clobbering its increment, and the tool recounts. Expired
 * messages are not counted, so the repaired number agrees with what
 * `getMessages` returns rather than with what the table still holds.
 */
export async function reconcileMessageCount(
  context: HistoryContext,
  sessionId: string,
  signal?: AbortSignal,
): Promise<number> {
  return repairMessageCount(context, parseSessionId(sessionId), signal);
}
