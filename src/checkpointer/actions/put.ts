import type { RunnableConfig } from '@langchain/core/runnables';
import type {
  ChannelVersions,
  Checkpoint,
  CheckpointMetadata,
} from '@langchain/langgraph-checkpoint';

import { releasableS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { retryFor } from '../../shared/dynamodb/retry-policy';
import { ValidationError } from '../../shared/errors/errors';
import { calculateTtlTimestamp } from '../../shared/validation/ttl';
import { verifyCheckpointLanded } from '../internal/checkpoint-write-verify';
import { readConfigurable } from '../internal/configurable';
import { buildCheckpointItems } from '../internal/item-writer';
import type { CheckpointerContext } from '../internal/setup';
import { validateCheckpointId } from '../internal/validation';

/**
 * Persist a checkpoint and its metadata as a transactional pair of META and
 * PAYLOAD items, returning the config that addresses the stored checkpoint. The
 * incoming `checkpoint_id` (if any) becomes the new checkpoint's parent.
 *
 * **Every channel value the checkpoint carries is stored.** `newVersions` is
 * accepted because `BaseCheckpointSaver.put` declares it
 * (`@langchain/langgraph-checkpoint@1.1.5` `dist/base.d.ts:68`) and is
 * deliberately ignored: narrowing the stored values to the ones it names, and
 * carrying the rest forward from the parent, made a put whose `newVersions` is
 * `{}` write no values at all. LangGraph passes `{}` when forking a checkpoint
 * and when writing an empty-checkpoint update (`@langchain/langgraph@1.4.13`
 * `dist/pregel/index.js:668` and `:613`), so that put silently dropped user
 * state. The reference saver does not narrow either: `MemorySaver.put` takes
 * three parameters and stores the whole checkpoint (`dist/memory.js:206`).
 *
 * Accepts: `config` — its `checkpoint_id`, when present, becomes the new
 * checkpoint's parent. `checkpoint.id` — validated as the sort-key segment it
 * becomes. `metadata` — stored beside it, on the light row a listing reads.
 * `config.signal` — cancels the writes' retries; checked before anything is
 * encoded.
 *
 * Returns: the config addressing the stored checkpoint, which is what the
 * caller passes back to continue the thread.
 *
 * Throws: ValidationError naming `config`, `configurable` or `signal` for a
 * config of the wrong shape, `thread_id`, `checkpoint_ns`, `checkpoint_id` or
 * `thread_ts` for a malformed identifier, `checkpoint` for a `null` or
 * `undefined` checkpoint, `checkpoint_id` for a malformed `checkpoint.id`,
 * `payload` for a payload too large to store inline without `s3`, or `s3Key`
 * for an offloaded object's key over S3's cap; `S3_OFFLOAD_FAILED`; whatever
 * the transaction throws once the outcome is established.
 *
 * Guarantees: both rows land or neither does — they are one transaction, so a
 * META row never names a payload that is not there. Writing the same
 * `checkpoint.id` again replaces both, which is what a retry and a repair tool
 * both need. On failure with S3 offload configured both rows are read back
 * before any upload is deleted (see {@link verifyCheckpointLanded}). A
 * transaction that committed and lost its response is reported as success: the
 * row carrying an offloaded descriptor proves that on its own, even when the
 * other row cannot be read, because a landing deletes nothing. A confirmed
 * non-commit cleans up the objects this call uploaded except any either row
 * names when read back — another writer's committed checkpoint can hold the
 * same checkpoint object — so it needs both rows read. An unverifiable outcome,
 * which includes a non-commit whose other row could not be read, leaks them
 * rather than risk stranding a live row. A write of the same bytes whose upload
 * lands before the delete, and whose rows commit after those reads, can still
 * lose its object; closing that needs an out-of-band sweeper.
 */
export async function putCheckpoint(
  context: CheckpointerContext,
  config: RunnableConfig,
  checkpoint: Checkpoint,
  metadata: CheckpointMetadata,
  _newVersions?: ChannelVersions,
): Promise<RunnableConfig> {
  const { threadId, checkpointNs, checkpointId: parentCheckpointId } = readConfigurable(config);
  const signal = config.signal;
  if (checkpoint === null || checkpoint === undefined) {
    throw new ValidationError('checkpoint must be an object', 'checkpoint');
  }
  validateCheckpointId(checkpoint.id);
  const ttlTimestamp = context.ttl ? calculateTtlTimestamp(context.ttl) : undefined;
  const { meta, payload } = await buildCheckpointItems(
    context,
    threadId,
    checkpointNs,
    checkpoint,
    metadata,
    parentCheckpointId,
    ttlTimestamp,
  );
  const stored: RunnableConfig = {
    configurable: {
      thread_id: threadId,
      checkpoint_ns: checkpointNs,
      checkpoint_id: checkpoint.id,
    },
  };
  try {
    await withDynamoDBRetry(
      () =>
        context.client.transactWrite({
          TransactItems: [
            { Put: { TableName: context.tableName, Item: meta } },
            { Put: { TableName: context.tableName, Item: payload } },
          ],
        }),
      retryFor(context, signal),
    );
  } catch (error) {
    if (!context.offloader) throw error;
    const { verdict, live } = await verifyCheckpointLanded(context, meta, payload);
    if (verdict === 'landed') {
      context.logger.debug('put: transaction committed although its response was lost', {
        threadId,
        checkpointId: checkpoint.id,
      });
      return stored;
    }
    if (verdict === 'not-landed') {
      await cleanUpS3Orphans(
        context.offloader,
        releasableS3Keys([meta.metadata, payload.checkpoint], live),
        'put',
        context.logger,
      );
    }
    throw error;
  }
  return stored;
}
