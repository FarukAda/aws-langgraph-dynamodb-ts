import type { RunnableConfig } from '@langchain/core/runnables';

import {
  withDynamoDBRetry,
  calculateTTLTimestamp,
  calculateTTLTimestampFromSeconds,
  cleanUpS3Orphans,
} from '../../shared';
import {
  type CheckpointItem,
  type CheckpointPayloadItem,
  PAYLOAD_SK_PREFIX,
  type PutActionParams,
} from '../types';
import { validateCheckpointId, validateTTLDays } from '../utils';
import { validateConfigurable } from './validate-configurable';

/**
 * Save a checkpoint to DynamoDB as two items:
 * 1. Metadata item (SK = checkpoint_id) — lightweight, queried by list()
 * 2. Payload item  (SK = PAYLOAD#checkpoint_id) — heavy blob, fetched only by getTuple()
 *
 * Both items are written atomically via transactWrite.
 *
 * @param params - Parameters for the put operation
 * @returns RunnableConfig with the saved checkpoint information
 * @throws Error if validation fails or operation fails
 */
export const putAction = async (params: PutActionParams): Promise<RunnableConfig> => {
  const { thread_id } = validateConfigurable(params.config.configurable);

  // Validate checkpoint.id exists and is valid
  if (!params.checkpoint.id) {
    throw new Error('Checkpoint ID is required');
  }
  validateCheckpointId(params.checkpoint.id, true);
  validateTTLDays(params.ttlDays);

  const [type1, rawCheckpoint] = await params.serde.dumpsTyped(params.checkpoint);
  const [type2, rawMetadata] = await params.serde.dumpsTyped(params.metadata);

  if (type1 !== type2) {
    throw new Error('Failed to serialize checkpoint and metadata to the same type.');
  }

  // Compress after serialization if compressor is provided
  const serializedCheckpoint = params.compressor
    ? await params.compressor.compress(rawCheckpoint)
    : rawCheckpoint;
  const serializedMetadata = params.compressor
    ? await params.compressor.compress(rawMetadata)
    : rawMetadata;

  // S3 offloading for large payloads
  let s3CheckpointKey: string | undefined;
  let s3MetadataKey: string | undefined;
  let storedCheckpoint: Uint8Array = serializedCheckpoint;
  let storedMetadata: Uint8Array = serializedMetadata;

  if (params.s3Offloader) {
    const checkpointId = params.checkpoint.id;
    if (params.s3Offloader.shouldOffload(serializedCheckpoint)) {
      s3CheckpointKey = await params.s3Offloader.upload(
        params.s3Offloader.buildKey(thread_id, checkpointId, 'checkpoint'),
        serializedCheckpoint,
      );
      storedCheckpoint = new Uint8Array(0); // Empty placeholder in DynamoDB
    }
    if (params.s3Offloader.shouldOffload(serializedMetadata)) {
      s3MetadataKey = await params.s3Offloader.upload(
        params.s3Offloader.buildKey(thread_id, checkpointId, 'metadata'),
        serializedMetadata,
      );
      storedMetadata = new Uint8Array(0); // Empty placeholder in DynamoDB
    }
  }

  // Compute TTL once for both items
  let ttl: number | undefined;
  if (params.ttlSeconds !== undefined) {
    ttl = calculateTTLTimestampFromSeconds(params.ttlSeconds);
  } else if (params.ttlDays !== undefined) {
    ttl = calculateTTLTimestamp(params.ttlDays);
  }

  const checkpointNs = params.config.configurable?.checkpoint_ns ?? '';
  const checkpointId = params.checkpoint.id;

  // Metadata item — lightweight, read by list() queries
  const metadataItem: CheckpointItem & { ttl?: number } = {
    thread_id,
    checkpoint_ns: checkpointNs,
    checkpoint_id: checkpointId,
    parent_checkpoint_id: params.config.configurable?.checkpoint_id,
    type: type1,
    metadata: storedMetadata,
    s3_checkpoint_key: s3CheckpointKey,
    s3_metadata_key: s3MetadataKey,
  };

  if (ttl !== undefined) {
    metadataItem.ttl = ttl;
  }

  // Payload item — heavy blob, fetched only by getTuple()
  const payloadItem: CheckpointPayloadItem & { ttl?: number } = {
    thread_id,
    checkpoint_id: `${PAYLOAD_SK_PREFIX}${checkpointId}`,
    checkpoint: storedCheckpoint,
  };

  if (ttl !== undefined) {
    payloadItem.ttl = ttl;
  }

  // Optimistic-concurrency guard on the metadata Put.
  //
  // Two concurrent workers racing on the same (thread_id, checkpoint_id) with
  // *different* parent/type (= divergent lineage) is a bug we want to surface,
  // not silently resolve last-writer-wins. Two writers agreeing on parent+type
  // (= legitimate idempotent retry after a transient error) must still succeed.
  //
  //   attribute_not_exists(checkpoint_id)                 -- first write ever: OK
  //   OR (#type = :expected_type AND (                     -- OR same content as prior:
  //         attribute_not_exists(parent_checkpoint_id)     --    initial checkpoint
  //         OR parent_checkpoint_id = :expected_parent     --    with named parent
  //       ))
  //
  // The payload Put is left unconditional: payloads are keyed by PAYLOAD#<id>
  // and contain content-for-content equal data for a given checkpoint, so an
  // overwrite on retry is always safe.
  // Normalize `''` to `undefined` so an empty-string parent and an unset parent
  // are treated as the same "no parent" state. This keeps the ConditionExpression
  // stable across idempotent retries that might represent "initial checkpoint"
  // either way (e.g. a migration or a caller that stringifies nulls).
  const rawExpectedParent = params.config.configurable?.checkpoint_id;
  const expectedParent =
    typeof rawExpectedParent === 'string' && rawExpectedParent.length > 0
      ? rawExpectedParent
      : undefined;
  const metadataExpressionAttributeNames: Record<string, string> = { '#type': 'type' };
  const metadataExpressionAttributeValues: Record<string, unknown> = {
    ':expected_type': type1,
  };
  const parentClause =
    expectedParent !== undefined
      ? 'parent_checkpoint_id = :expected_parent'
      : 'attribute_not_exists(parent_checkpoint_id)';
  if (expectedParent !== undefined) {
    metadataExpressionAttributeValues[':expected_parent'] = expectedParent;
  }
  const metadataConditionExpression =
    'attribute_not_exists(checkpoint_id) ' + `OR (#type = :expected_type AND (${parentClause}))`;

  // Atomic write: both items must succeed or both fail.
  // On failure, best-effort-clean any S3 objects we uploaded so they don't linger
  // until the lifecycle rule sweeps them. Errors during cleanup are only logged.
  try {
    await withDynamoDBRetry(
      async () => {
        await params.client.transactWrite({
          TransactItems: [
            {
              Put: {
                TableName: params.checkpointsTableName,
                Item: metadataItem,
                ConditionExpression: metadataConditionExpression,
                ExpressionAttributeNames: metadataExpressionAttributeNames,
                ExpressionAttributeValues: metadataExpressionAttributeValues,
              },
            },
            { Put: { TableName: params.checkpointsTableName, Item: payloadItem } },
          ],
        });
      },
      { signal: params.signal },
    );
  } catch (err) {
    // Skip S3 orphan cleanup on the optimistic-lock conflict path. S3 keys are
    // derived deterministically from (thread_id, checkpoint_id), so a divergent
    // put() on the same checkpoint_id uploads to the *same* keys as the
    // canonical write already occupies — cleaning them up after a
    // ConditionalCheckFailed would delete live data still referenced by the
    // winning transaction. The S3 lifecycle rule is the safe backstop for the
    // rare case where an overwrite did occur; data integrity beats a few stale
    // bytes in S3.
    // `withDynamoDBRetry` always rejects with an `Error` instance, so reading
    // `.name` is sufficient — a name that matches neither (or a non-object error)
    // simply yields `undefined` and is treated as a non-conditional failure.
    const errorName = (err as { name?: unknown } | null | undefined)?.name;
    const isConditionalFailure =
      errorName === 'ConditionalCheckFailedException' ||
      errorName === 'TransactionCanceledException';

    if (params.s3Offloader && !isConditionalFailure) {
      await cleanUpS3Orphans(params.s3Offloader, [s3CheckpointKey, s3MetadataKey], 'put failure');
    }
    throw err;
  }

  return {
    configurable: {
      thread_id: metadataItem.thread_id,
      checkpoint_ns: metadataItem.checkpoint_ns,
      checkpoint_id: metadataItem.checkpoint_id,
    },
  };
};
