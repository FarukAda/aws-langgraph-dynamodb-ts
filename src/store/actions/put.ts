import { randomUUID } from 'node:crypto';

import type { PutOperation } from '@langchain/langgraph-checkpoint';

import { nowIso } from '../../shared/clock';
import { collectS3Keys, type DescriptorRef } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { calculateTtlTimestamp } from '../../shared/validation/ttl';
import type { JsonValue } from '../internal/filter';
import { syncVectorIndex } from '../internal/index-sync';
import { buildStoreItem } from '../internal/item-mapper';
import { partitionKey, sortKey } from '../internal/keys';
import { persistRecord } from '../internal/persist';
import { readExisting } from '../internal/read-existing';
import { embedValue } from '../internal/semantic-search';
import type { StoreContext } from '../internal/setup';
import { validateStoreKey } from '../internal/validation';
import { isRetryExhausted, rowIsAbsent } from '../internal/write-verify';

/**
 * Delete the item and, when a vector backend is configured, drop its vector.
 *
 * The delete asks DynamoDB for the row it removed (`ReturnValues: 'ALL_OLD'`),
 * so S3 cleanup targets the descriptor that was actually removed rather than
 * one read a moment earlier — a concurrent put between a pre-read and the
 * delete used to leave its just-written object orphaned — and the delete costs
 * one request instead of two.
 *
 * A retry-exhausted failure is *ambiguous*: the delete may have landed
 * server-side with only its acknowledgement lost. Mirroring `persistRecord`,
 * that case is resolved with a strongly-consistent read — if the row is gone
 * the delete succeeded and the vector-backend delete must still run. The
 * removed descriptor travelled with the lost response, so that one object, if
 * any, is left to the lifecycle rule. Any other failure, or a row still
 * present, propagates unchanged.
 */
async function deleteStoreItem(
  context: StoreContext,
  op: PutOperation,
  pk: string,
  sk: string,
): Promise<void> {
  let removed: DescriptorRef | undefined;
  try {
    const result = await withDynamoDBRetry(
      () =>
        context.client.delete({
          TableName: context.tableName,
          Key: { PK: pk, SK: sk },
          ReturnValues: 'ALL_OLD',
        }),
      context.retry,
    );
    removed = (result.Attributes as { value?: DescriptorRef } | undefined)?.value;
  } catch (error) {
    const landed =
      isRetryExhausted(error as Error) && (await rowIsAbsent(context, { PK: pk, SK: sk }));
    if (!landed) throw error;
  }
  if (context.offloader && removed) {
    await cleanUpS3Orphans(
      context.offloader,
      collectS3Keys([removed]),
      'store.delete',
      context.logger,
      {
        scope: [...op.namespace, op.key],
      },
    );
  }
  if (context.vectorBackend) {
    await syncVectorIndex(context.vectorBackend, op.namespace, op.key, undefined, context.logger);
  }
}

/** Compute the embedding for a put, honoring `op.index` (false disables it). */
async function resolveEmbedding(
  context: StoreContext,
  op: PutOperation,
  value: Record<string, JsonValue>,
): Promise<number[] | undefined> {
  if (op.index === false) return undefined;
  return embedValue(context, value, Array.isArray(op.index) ? op.index : undefined);
}

/**
 * Store, update, or delete an item (null deletes). The value is encoded
 * (optional compression/S3 offload, nonced per call so a failed write can never
 * delete the previous payload) and `createdAt` is preserved across updates; a
 * computed embedding is sent to a configured `vectorBackend` instead of being
 * stored on the item — DynamoDB always holds the canonical item.
 */
export async function putItem(context: StoreContext, op: PutOperation): Promise<void> {
  validateStoreKey(op.namespace, op.key);
  const pk = partitionKey(op.namespace);
  const sk = sortKey(op.namespace, op.key);
  if (op.value === null) {
    await deleteStoreItem(context, op, pk, sk);
    return;
  }
  const value = op.value as Record<string, JsonValue>;
  const timestamp = nowIso();
  const existing = await readExisting(context, pk, sk);
  const embedding = await resolveEmbedding(context, op, value);
  const ttlTimestamp = context.ttl ? calculateTtlTimestamp(context.ttl) : undefined;
  const record = await buildStoreItem(context, op.namespace, op.key, value, {
    createdAt: existing.createdAt ?? timestamp,
    updatedAt: timestamp,
    embedding: context.vectorBackend ? undefined : embedding,
    ttlTimestamp,
    nonce: randomUUID(),
  });
  await persistRecord(context, record, existing);
  if (context.vectorBackend) {
    await syncVectorIndex(context.vectorBackend, op.namespace, op.key, embedding, context.logger);
  }
}
