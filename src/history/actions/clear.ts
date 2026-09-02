import type { PayloadDescriptor } from '../../shared/codec/codec';
import { deletePartitionRows } from '../../shared/dynamodb/partition-delete';
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
 * Delete a whole session: every message item plus the metadata item, best-effort
 * deleting any offloaded S3 objects. Rows this adapter does not own are left in
 * place and logged, so a shared-table partition holding a foreign row is never
 * collaterally wiped.
 */
export async function clearSession(context: HistoryContext, sessionId: string): Promise<void> {
  validateSessionId(sessionId);
  await deletePartitionRows({
    client: context.client,
    tableName: context.tableName,
    params: sessionItemsQuery(context.tableName, sessionId, { consistent: true }),
    logger: context.logger,
    offloader: context.offloader,
    operation: 'history.clear',
    ownsSortKey: isHistorySortKey,
    descriptorsOf,
    scope: [sessionId],
  });
}
