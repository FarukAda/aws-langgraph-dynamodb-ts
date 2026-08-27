import { randomUUID } from 'node:crypto';

import type { PutOperation } from '@langchain/langgraph-checkpoint';

import { nowIso } from '../../shared/clock';
import { type PayloadDescriptor, PayloadLocation } from '../../shared/codec/codec';
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
import { writeLandedAt } from '../internal/write-verify';
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

/** True when `error` is a {@link RetryExhaustedError} — checked by name, not `instanceof` (banned repo-wide). */
function isRetryExhausted(error: Error): boolean {
  return error.name === 'RetryExhaustedError';
}

/** Put the record: on a definite failure, clean up *this* record's nonced S3 object; on an ambiguous retry-exhaustion failure, verify via `writeLandedAt` before deleting anything — if it landed, clean up the *previous* row's object instead, like the ordinary success path. */
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
    const landed =
      isRetryExhausted(error as Error) &&
      record.value.location === PayloadLocation.S3 &&
      (await writeLandedAt(context, record, record.value.s3Key));
    if (!landed) {
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

/** Store, update, or delete an item (null deletes). The value is encoded (optional compression/S3 offload, nonced per call so a failed write can never delete the previous payload) and `createdAt` is preserved across updates; a computed embedding is sent to a configured `vectorBackend` instead of being stored on the item — DynamoDB always holds the canonical item. */
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
