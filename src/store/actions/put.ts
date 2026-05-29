import type { PutOperation } from '@langchain/langgraph-checkpoint';

import { nowIso } from '../../shared/clock';
import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { calculateTtlTimestamp } from '../../shared/validation/ttl';
import type { JsonValue } from '../internal/filter';
import { buildStoreItem } from '../internal/item-mapper';
import { partitionKey, sortKey } from '../internal/keys';
import { embedValue } from '../internal/semantic-search';
import type { StoreContext } from '../internal/setup';
import { validateKey, validateNamespace } from '../internal/validation';

async function readCreatedAt(
  context: StoreContext,
  pk: string,
  sk: string,
): Promise<string | undefined> {
  const existing = await withDynamoDBRetry(() =>
    context.client.get({
      TableName: context.tableName,
      Key: { PK: pk, SK: sk },
      ConsistentRead: true,
      ProjectionExpression: '#c',
      ExpressionAttributeNames: { '#c': 'createdAt' },
    }),
  );
  return existing.Item?.createdAt as string | undefined;
}

/**
 * Store, update, or delete an item. A null value deletes; otherwise the value
 * is encoded (with optional compression/S3 offload), `createdAt` is preserved
 * across updates, and an embedding is computed when indexing is enabled. When a
 * `vectorBackend` is configured the embedding is sent there (and not stored on
 * the item); DynamoDB always holds the canonical item.
 */
export async function putItem(context: StoreContext, op: PutOperation): Promise<void> {
  validateNamespace(op.namespace);
  validateKey(op.key);
  const pk = partitionKey(op.namespace);
  const sk = sortKey(op.namespace, op.key);
  if (op.value === null) {
    await withDynamoDBRetry(() =>
      context.client.delete({ TableName: context.tableName, Key: { PK: pk, SK: sk } }),
    );
    if (context.vectorBackend) await context.vectorBackend.delete(op.namespace, op.key);
    return;
  }
  const value = op.value as Record<string, JsonValue>;
  const timestamp = nowIso();
  const createdAt = (await readCreatedAt(context, pk, sk)) ?? timestamp;
  const embedding =
    op.index === false
      ? undefined
      : await embedValue(context, value, Array.isArray(op.index) ? op.index : undefined);
  const ttlTimestamp = context.ttl ? calculateTtlTimestamp(context.ttl) : undefined;
  const record = await buildStoreItem(context, op.namespace, op.key, value, {
    createdAt,
    updatedAt: timestamp,
    embedding: context.vectorBackend ? undefined : embedding,
    ttlTimestamp,
  });
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
  if (context.vectorBackend && embedding) {
    await context.vectorBackend.upsert(op.namespace, op.key, embedding);
  }
}
