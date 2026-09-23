import { deletePartitionRows } from '../../shared/dynamodb/partition-delete';
import { retryFor } from '../../shared/dynamodb/retry';
import { parseThreadId } from '../internal/parse';
import {
  checkpointRowDescriptors,
  checkpointRowKind,
  checkpointRowUnit,
  isCheckpointerSortKey,
  partitionKey,
  partitionQuery,
  WRITE_GROUP_ATTRIBUTE,
} from '../internal/rows';
import type { CheckpointerContext } from '../internal/setup';

/**
 * Delete exactly the checkpoint, payload and write rows of one thread that the
 * partition read observed.
 *
 * Accepts: `threadId` — validated like every identifier. `options.signal` —
 * stops the read between pages.
 *
 * Returns: nothing. Deleting a thread that does not exist is not an error:
 * there is simply nothing in the partition.
 *
 * Throws: `VALIDATION` for a malformed `threadId`;
 * `BATCH_WRITE_INCOMPLETE` when a row's delete fails, carrying what did
 * succeed; `ABORTED` when the signal fires, whether between pages or during
 * a row's delete — a cancel is reported as a cancel and never as an incomplete
 * delete, and no further row is issued after it. A refused row is **not** one of
 * those failures and raises nothing: the pin turned it away because it was
 * rewritten after the read, and deleting it would erase a write already
 * acknowledged to its author and release the object that write uploaded, so
 * leaving it is the safe answer rather than a degraded one. The error's two
 * counts are **rows**, not batches — rows deleted and rows attempted, summed
 * across every flush of the pass, with `details.succeededCount` repeating the first
 * and `details.failedChunks` holding each failing row's own error — and its message says so,
 * because a pass that sends one request per row is not a batch that did not
 * drain. Refused rows are in neither count; they are reported at `warn` with
 * their sort keys and counted as skipped. The remedy for a refusal is the same
 * as for a row written after the read: re-run once the thread is quiescent.
 *
 * Guarantees: a row this adapter did not write is left in place and logged, so
 * a shared-table partition is never collaterally wiped. A row written or
 * rewritten after the read is left in place and reported too: every delete is
 * pinned on the id of the write that produced the row it names, so a checkpoint
 * re-put while this runs keeps both its rows and the objects they name, and its
 * pending writes are then left alone with them. A row written before that id
 * existed carries none and is deleted as it always was. A row written at a key
 * the read never saw still survives the pass, which is why the thread should be
 * quiescent.
 */
export async function deleteThread(
  context: CheckpointerContext,
  threadId: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const thread = parseThreadId(threadId);
  await deletePartitionRows({
    client: context.client,
    tableName: context.tableName,
    params: partitionQuery(context.tableName, partitionKey(thread), { consistent: true }),
    logger: context.logger,
    retry: retryFor(context, options.signal),
    signal: options.signal,
    offloader: context.offloader,
    operation: 'deleteThread',
    ownsSortKey: isCheckpointerSortKey,
    descriptorsOf: checkpointRowDescriptors,
    idAttribute: WRITE_GROUP_ATTRIBUTE,
    unitOf: checkpointRowUnit,
    kindOf: checkpointRowKind,
    scope: [thread],
  });
}
