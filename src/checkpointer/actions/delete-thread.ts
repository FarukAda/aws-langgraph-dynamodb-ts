import type { PayloadDescriptor } from '../../shared/codec/codec';
import { deletePartitionRows } from '../../shared/dynamodb/partition-delete';
import { retryFor } from '../../shared/dynamodb/retry-policy';
import type { DocItem } from '../../shared/dynamodb/types';
import { isCheckpointerSortKey, partitionKey } from '../internal/keys';
import { partitionQuery } from '../internal/query';
import type { CheckpointerContext } from '../internal/setup';
import { validateThreadId } from '../internal/validation';

/** The offloaded payloads a checkpointer row can reference. */
function descriptorsOf(row: DocItem): (PayloadDescriptor | undefined)[] {
  return [
    row.metadata as PayloadDescriptor | undefined,
    row.checkpoint as PayloadDescriptor | undefined,
    row.value as PayloadDescriptor | undefined,
  ];
}

/**
 * Delete every checkpoint, payload, and write for a thread (all share the
 * thread's partition), best-effort deleting any offloaded S3 objects. Rows
 * this adapter does not own are left in place and logged, so a shared-table
 * partition holding a foreign row is never collaterally wiped.
 */
export async function deleteThread(
  context: CheckpointerContext,
  threadId: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  validateThreadId(threadId);
  await deletePartitionRows({
    client: context.client,
    tableName: context.tableName,
    params: partitionQuery(context.tableName, partitionKey(threadId), { consistent: true }),
    logger: context.logger,
    retry: retryFor(context, options.signal),
    signal: options.signal,
    offloader: context.offloader,
    operation: 'deleteThread',
    ownsSortKey: isCheckpointerSortKey,
    descriptorsOf,
    scope: [threadId],
  });
}
