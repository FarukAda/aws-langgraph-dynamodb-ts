import type { DocItem } from '../../shared/dynamodb/client';
import { WRITE_ID_ATTRIBUTE } from '../../shared/dynamodb/idempotent-write';
import {
  deletePartitionRows,
  namedDescriptor,
  type NamedDescriptor,
} from '../../shared/dynamodb/partition-delete';
import { retryFor } from '../../shared/dynamodb/retry';
import { parseSessionId } from '../internal/parse';
import { isHistorySortKey, sessionItemsQuery } from '../internal/rows';
import type { HistoryContext } from '../internal/setup';

/**
 * The offloaded payload a chat-history row references, named by the attribute
 * holding it, because a message row is pinned through a document path over that
 * name. The session row carries no payload and is pinned top-level instead, and
 * a row holding `null` there carries none either — `namedDescriptor` decides.
 */
function descriptorsOf(row: DocItem): NamedDescriptor[] {
  const entry = namedDescriptor(row, 'message');
  return entry === undefined ? [] : [entry];
}

/**
 * Delete exactly the message rows and the session row of one session that the
 * partition read observed.
 *
 * Accepts: `sessionId` — validated. `options.signal` — aborts between pages.
 *
 * Returns: nothing. Clearing a session that does not exist is not an error;
 * there is simply nothing in the partition.
 *
 * Throws: `VALIDATION` naming `sessionId`; `BATCH_WRITE_INCOMPLETE`
 * when a row's delete fails, carrying what did succeed; `ABORTED` when the
 * signal fires, whether between pages or during a row's delete — a cancel is
 * reported as a cancel and never as an incomplete delete, and no further row
 * is issued after it. A refused
 * row raises nothing and is not one of those failures: the pin turned it away
 * because an append landed after the read, and deleting the session row then
 * would remove the `messageCount`, the `updatedAt` and the recency-index entry
 * of a session that is still alive — leaving it is the safe answer. The error's
 * two counts are **rows**, not batches — rows deleted and rows attempted,
 * summed across every flush of the pass, with `details.succeededCount` repeating
 * the first and `details.failedChunks` holding each failing row's own error — and its
 * message says so, because a pass that sends one request per row is not a batch
 * that did not drain. Refused rows are in neither count; each is reported at
 * `warn` with its sort key and counted as skipped. The remedy is to re-run once
 * the session is quiescent, and `reconcileMessageCount` repairs the count the
 * surviving session row is left over-counting in the meantime.
 *
 * Guarantees: a row this adapter did not write is left in place and logged, so
 * a shared-table partition is never collaterally wiped. Offloaded objects are
 * deleted best-effort after their rows, and only objects under this session's
 * own path. A row rewritten after the read is left in place and reported: an
 * append landing during the call moves the session row's own write id, so that
 * row survives while the messages the read saw are still deleted, and its
 * `messageCount` then over-counts until `reconcileMessageCount` repairs it —
 * which is the right outcome, the session being alive. One pass over a
 * quiescent session: a message appended while this runs may survive it.
 */
export async function clearSession(
  context: HistoryContext,
  sessionId: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const session = parseSessionId(sessionId);
  await deletePartitionRows({
    client: context.client,
    tableName: context.tableName,
    params: sessionItemsQuery(context.tableName, session, { consistent: true }),
    logger: context.logger,
    retry: retryFor(context, options.signal),
    signal: options.signal,
    offloader: context.offloader,
    operation: 'history.clear',
    ownsSortKey: isHistorySortKey,
    descriptorsOf,
    idAttribute: WRITE_ID_ATTRIBUTE,
    scope: [session],
  });
}
