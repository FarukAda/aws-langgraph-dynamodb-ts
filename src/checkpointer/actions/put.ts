import type { RunnableConfig } from '@langchain/core/runnables';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { retryFor } from '../../shared/dynamodb/retry-policy';
import { createUlidFactory } from '../../shared/ulid';
import { calculateTtlTimestamp } from '../../shared/validation/ttl';
import { verifyCheckpointLanded } from '../internal/checkpoint-write-verify';
import { readConfigurable } from '../internal/configurable';
import { buildCheckpointItems } from '../internal/item-writer';
import type { CheckpointerContext } from '../internal/setup';
import { validateCheckpointId } from '../internal/validation';

/**
 * Nonces every put's S3 uploads (see {@link buildCheckpointItems}). A ULID
 * rather than a UUID because it sorts by time, which keeps a bucket listing of
 * one checkpoint's objects readable.
 */
const nextPutNonce = createUlidFactory();

/**
 * Persist a checkpoint and its metadata as a transactional pair of META and
 * PAYLOAD items, returning the config that addresses the stored checkpoint. The
 * incoming `checkpoint_id` (if any) becomes the new checkpoint's parent.
 *
 * On failure with S3 offload configured, the rows are read back before any
 * upload is deleted (see {@link verifyCheckpointLanded}): a transaction that
 * committed and lost its response is reported as success, a confirmed
 * non-commit cleans up this call's own nonced uploads, and an unverifiable
 * outcome leaks them rather than risk stranding a live row.
 */
export async function putCheckpoint(
  context: CheckpointerContext,
  config: RunnableConfig,
  checkpoint: Checkpoint,
  metadata: CheckpointMetadata,
): Promise<RunnableConfig> {
  const { threadId, checkpointNs, checkpointId: parentCheckpointId } = readConfigurable(config);
  const signal = config.signal;
  validateCheckpointId(checkpoint.id);
  const ttlTimestamp = context.ttl ? calculateTtlTimestamp(context.ttl) : undefined;
  const { meta, payload } = await buildCheckpointItems(
    context,
    threadId,
    checkpointNs,
    checkpoint,
    metadata,
    nextPutNonce(),
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
    const verdict = await verifyCheckpointLanded(context, meta, payload);
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
        collectS3Keys([meta.metadata, payload.checkpoint]),
        'put',
        context.logger,
      );
    }
    throw error;
  }
  return stored;
}
