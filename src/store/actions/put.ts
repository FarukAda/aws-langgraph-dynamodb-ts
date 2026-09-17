import { randomUUID } from 'node:crypto';

import type { PutOperation } from '@langchain/langgraph-checkpoint';

import { nowIso } from '../../shared/clock';
import {
  collectS3Keys,
  type DescriptorRef,
  releasableS3Keys,
} from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { calculateTtlTimestamp } from '../../shared/validation/ttl';
import type { JsonValue } from '../internal/filter';
import { syncVectorIndex } from '../internal/index-sync';
import { buildStoreItem } from '../internal/item-mapper';
import { partitionKey, sortKey } from '../internal/keys';
import { assertPutOperation } from '../internal/operation-validation';
import { persistRecord } from '../internal/persist';
import { readExisting } from '../internal/read-existing';
import { embedPassages, embedValue } from '../internal/semantic-search';
import type { StoreContext } from '../internal/setup';
import { isRetryExhausted, readLiveValue, rowIsAbsent } from '../internal/write-verify';

/**
 * Release the object the deleted row named, unless the row read just before the
 * release names it. A racer that puts the same value again after this delete
 * uploads to the same key and commits a row pointing at it, so the row is read
 * before anything goes. The read is spent only when the removed value was
 * offloaded, and a read that fails releases nothing.
 */
async function releaseRemoved(
  context: StoreContext,
  op: PutOperation,
  key: { PK: string; SK: string },
  removed: DescriptorRef | undefined,
): Promise<void> {
  if (!context.offloader || !removed || collectS3Keys([removed]).length === 0) return;
  const live = await readLiveValue(context, key);
  if (live === undefined) {
    context.logger.debug(
      'store.delete: the row could not be read back; the removed object is left to the lifecycle rule',
      { namespace: op.namespace, key: op.key },
    );
    return;
  }
  await cleanUpS3Orphans(
    context.offloader,
    releasableS3Keys([removed], live.value ? [live.value] : []),
    'store.delete',
    context.logger,
    { scope: [...op.namespace, op.key] },
  );
}

/**
 * Delete the item and, when a vector backend is configured, drop its vector.
 *
 * The delete asks DynamoDB for the row it removed (`ReturnValues: 'ALL_OLD'`),
 * so S3 cleanup targets the descriptor that was actually removed rather than
 * one read a moment earlier — a concurrent put between a pre-read and the
 * delete used to leave its just-written object orphaned. Deleting an inline item
 * costs one request. An offloaded one is followed by a read of the row, because
 * a racer that puts the same value after the delete holds the removed key (see
 * {@link releaseRemoved}).
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
  await releaseRemoved(context, op, { PK: pk, SK: sk }, removed);
  if (context.vectorBackend) {
    await syncVectorIndex(context.vectorBackend, op.namespace, op.key, undefined, context.logger);
  }
}

/**
 * The vectors a put stores on the row: one per extracted path, scored by best
 * match on read. Not computed when a `vectorBackend` holds the vectors, which
 * takes a single vector per item instead (see {@link resolveEmbedding}).
 */
async function resolvePassages(
  context: StoreContext,
  op: PutOperation,
  value: Record<string, JsonValue>,
): Promise<number[][] | undefined> {
  if (op.index === false) return undefined;
  return embedPassages(context, value, Array.isArray(op.index) ? op.index : undefined);
}

/** Compute the single joined embedding a `vectorBackend` indexes, honoring `op.index`. */
async function resolveEmbedding(
  context: StoreContext,
  op: PutOperation,
  value: Record<string, JsonValue>,
): Promise<number[] | undefined> {
  if (op.index === false) return undefined;
  return embedValue(context, value, Array.isArray(op.index) ? op.index : undefined);
}

/**
 * Store, update or delete an item.
 *
 * Accepts: `op.value` — `null` deletes; anything else is stored, encoded with
 * optional compression and S3 offload addressed by content hash under this
 * row's own path. `op.index` — `false` stores the item without indexing it and
 * clears any vector it had, an array overrides the configured fields for this
 * put, and absent uses the store's configuration.
 *
 * Returns: nothing. Deleting an item that is not there is not an error.
 *
 * Throws: ValidationError naming `namespace`, `key`, `index`, or `value` for a
 * value that is neither an object nor `null`, or that JSON cannot represent —
 * refused at the write rather than stored as a row that can never be read back;
 * `S3_OFFLOAD_FAILED`; whatever the write throws.
 *
 * Guarantees: DynamoDB holds the canonical item — the vector index is synced
 * afterwards and best-effort, so a backend outage never fails a put or leaves a
 * half-written item. `createdAt` survives every update. The superseded payload
 * is deleted only once the new row is committed, and a removed or superseded
 * object only when a read of the row just before the release does not name it.
 * A write of the same bytes whose upload lands before the delete, and whose row
 * commits after that read, can still lose its object; closing that needs an
 * out-of-band sweeper.
 */
export async function putItem(context: StoreContext, op: PutOperation): Promise<void> {
  assertPutOperation(op);
  const pk = partitionKey(op.namespace);
  const sk = sortKey(op.namespace, op.key);
  if (op.value === null) {
    await deleteStoreItem(context, op, pk, sk);
    return;
  }
  const value = op.value as Record<string, JsonValue>;
  const timestamp = nowIso();
  const existing = await readExisting(context, pk, sk);
  /**
   * The two indexing modes are exclusive, so only one of them embeds: the row
   * carries a vector per extracted path, while a configured backend takes one
   * vector per item because that is what its `upsert` contract addresses.
   */
  const backend = context.vectorBackend;
  const embedding = backend ? await resolveEmbedding(context, op, value) : undefined;
  const embeddings = backend ? undefined : await resolvePassages(context, op, value);
  const ttlTimestamp = context.ttl ? calculateTtlTimestamp(context.ttl) : undefined;
  const record = await buildStoreItem(context, op.namespace, op.key, value, {
    createdAt: existing.createdAt ?? timestamp,
    updatedAt: timestamp,
    embeddings,
    ttlTimestamp,
    rev: randomUUID(),
  });
  await persistRecord(context, record, existing);
  if (backend) {
    await syncVectorIndex(backend, op.namespace, op.key, embedding, context.logger);
  }
}
