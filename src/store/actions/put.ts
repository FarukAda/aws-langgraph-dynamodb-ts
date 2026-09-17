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
import { assertPutOperation } from '../internal/operation-validation';
import { persistRecord } from '../internal/persist';
import { readExisting } from '../internal/read-existing';
import { embedPassages, embedValue } from '../internal/semantic-search';
import type { StoreContext } from '../internal/setup';
import { isRetryExhausted, rowIsAbsent } from '../internal/write-verify';

/**
 * Delete the item and, when a vector backend is configured, drop its vector.
 *
 * The delete asks DynamoDB for the row it removed (`ReturnValues: 'ALL_OLD'`),
 * so S3 cleanup targets the descriptor that was actually removed rather than
 * one read a moment earlier — a concurrent put between a pre-read and the
 * delete used to leave its just-written object orphaned — and the delete costs
 * one request. The removed object is released without reading the row again:
 * every put uploads under an id of its own, so another put that recreates the
 * item names an object of its own, never the removed one.
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
      { scope: [...op.namespace, op.key] },
    );
  }
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
 * optional compression and S3 offload under this row's own path, in an object
 * named by this put's own id. `op.index` — `false` stores the item without indexing it and
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
 * is deleted only once the new row is committed, and this put's own upload
 * only once a read proves its write did not land. Neither release reads the
 * row first: each put uploads under a key ending in an id of its own, so the
 * object a put uploads is named only by that put's own rows.
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
