import { randomUUID } from 'node:crypto';

import type { PutOperation } from '@langchain/langgraph-checkpoint';

import { nowIso } from '../../shared/clock';
import type { PayloadDescriptor } from '../../shared/codec/codec';
import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { calculateTtlTimestamp } from '../../shared/validation/ttl';
import type { JsonValue } from '../internal/filter';
import { syncVectorIndex } from '../internal/index-sync';
import { buildStoreItem } from '../internal/item-mapper';
import { partitionKey, sortKey } from '../internal/keys';
import { embedValue } from '../internal/semantic-search';
import type { StoreContext } from '../internal/setup';
import { validateKey, validateNamespace } from '../internal/validation';
import type { StoreItemRecord } from '../types';

/** The previous row's createdAt and value descriptor, read once before a put. */
interface ExistingRecordMeta {
  createdAt?: string;
  value?: PayloadDescriptor;
}

async function readExisting(
  context: StoreContext,
  pk: string,
  sk: string,
): Promise<ExistingRecordMeta> {
  const existing = await withDynamoDBRetry(() =>
    context.client.get({
      TableName: context.tableName,
      Key: { PK: pk, SK: sk },
      ConsistentRead: true,
      ProjectionExpression: '#c, #v',
      ExpressionAttributeNames: { '#c': 'createdAt', '#v': 'value' },
    }),
  );
  return {
    createdAt: existing.Item?.createdAt as string | undefined,
    value: existing.Item?.value as PayloadDescriptor | undefined,
  };
}

/** Delete the item and, when a vector backend is configured, drop its vector. */
async function deleteStoreItem(
  context: StoreContext,
  op: PutOperation,
  pk: string,
  sk: string,
): Promise<void> {
  const existing = context.offloader ? await readExisting(context, pk, sk) : undefined;
  await withDynamoDBRetry(() =>
    context.client.delete({ TableName: context.tableName, Key: { PK: pk, SK: sk } }),
  );
  if (context.offloader) {
    await cleanUpS3Orphans(
      context.offloader,
      collectS3Keys(existing?.value ? [existing.value] : []),
      'store.delete',
      context.logger,
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
 * Put the record. On failure, best-effort clean the S3 object *this* record
 * would have referenced — safe because its key is nonced, never the previous
 * row's key. On success, best-effort clean the previous row's S3 object (if
 * any) now that it's safely superseded.
 */
async function persistRecord(
  context: StoreContext,
  record: StoreItemRecord,
  previousValue: PayloadDescriptor | undefined,
): Promise<void> {
  try {
    await withDynamoDBRetry(() =>
      context.client.put({ TableName: context.tableName, Item: record }),
    );
  } catch (error) {
    if (context.offloader) {
      await cleanUpS3Orphans(
        context.offloader,
        collectS3Keys([record.value]),
        'store.put',
        context.logger,
      );
    }
    throw error;
  }
  if (context.offloader && previousValue) {
    await cleanUpS3Orphans(
      context.offloader,
      collectS3Keys([previousValue]),
      'store.put.overwrite',
      context.logger,
    );
  }
}

/**
 * Store, update, or delete an item. A null value deletes; otherwise the value
 * is encoded (with optional compression/S3 offload, under a per-call nonce so
 * a failed write can never delete the previous version's payload) and
 * `createdAt` is preserved across updates. An embedding is computed when
 * indexing is enabled. When a `vectorBackend` is configured the embedding is
 * sent there (and not stored on the item); DynamoDB always holds the
 * canonical item.
 */
export async function putItem(context: StoreContext, op: PutOperation): Promise<void> {
  validateNamespace(op.namespace);
  validateKey(op.key);
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
  await persistRecord(context, record, existing.value);
  if (context.vectorBackend) {
    await syncVectorIndex(context.vectorBackend, op.namespace, op.key, embedding, context.logger);
  }
}
