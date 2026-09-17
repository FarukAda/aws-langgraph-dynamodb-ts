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
 * Delete every checkpoint, payload and write of one thread.
 *
 * Accepts: `threadId` — validated like every identifier. `options.signal` —
 * stops the read between pages.
 *
 * Returns: nothing. Deleting a thread that does not exist is not an error:
 * there is simply nothing in the partition.
 *
 * Throws: ValidationError for a malformed `threadId`;
 * `BatchWriteAllIncompleteError` when a delete batch does not drain, carrying
 * what did succeed; `AbortError` when the signal fires.
 *
 * Guarantees: a row this adapter did not write is left in place and logged, so
 * a shared-table partition is never collaterally wiped. One pass over a
 * quiescent thread, deleting rows and then the objects they named with no read
 * in between: a checkpoint written while this runs may survive it.
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
