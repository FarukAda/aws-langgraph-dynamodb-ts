import type { PayloadDescriptor } from '../../shared/codec/codec';
import { deletePartitionRows } from '../../shared/dynamodb/partition-delete';
import { retryFor } from '../../shared/dynamodb/retry-policy';
import type { DocItem } from '../../shared/dynamodb/types';
import { isHistorySortKey } from '../internal/keys';
import { sessionItemsQuery } from '../internal/query';
import type { HistoryContext } from '../internal/setup';
import { validateSessionId } from '../internal/validation';

/** The offloaded payload a chat-history row can reference. */
function descriptorsOf(row: DocItem): (PayloadDescriptor | undefined)[] {
  return [row.message as PayloadDescriptor | undefined];
}

/**
 * Delete a whole session: every message item plus the metadata item.
 *
 * Accepts: `sessionId` — validated. `options.signal` — aborts between pages.
 *
 * Returns: nothing. Clearing a session that does not exist is not an error;
 * there is simply nothing in the partition.
 *
 * Throws: ValidationError naming `sessionId`; `BatchWriteAllIncompleteError`
 * when a delete batch does not drain, carrying what did succeed; `AbortError`.
 *
 * Guarantees: a row this adapter did not write is left in place and logged, so
 * a shared-table partition is never collaterally wiped. Offloaded objects are
 * deleted best-effort after their rows, and only objects under this session's
 * own path. One pass over a quiescent session: a message appended while this
 * runs may survive it.
 */
export async function clearSession(
  context: HistoryContext,
  sessionId: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  validateSessionId(sessionId);
  await deletePartitionRows({
    client: context.client,
    tableName: context.tableName,
    params: sessionItemsQuery(context.tableName, sessionId, { consistent: true }),
    logger: context.logger,
    retry: retryFor(context, options.signal),
    signal: options.signal,
    offloader: context.offloader,
    operation: 'history.clear',
    ownsSortKey: isHistorySortKey,
    descriptorsOf,
    scope: [sessionId],
  });
}
