import type { PutOperation } from '@langchain/langgraph-checkpoint';

import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { calculateTtlTimestamp } from '../../shared/validation/ttl';
import type { JsonValue } from '../internal/filter';
import { buildStoreItem } from '../internal/item-mapper';
import { namespaceToPartition } from '../internal/keys';
import { embedValue } from '../internal/semantic-search';
import type { StoreContext } from '../internal/setup';
import { nowIso, validateKey, validateNamespace } from '../internal/validation';

async function readCreatedAt(
  context: StoreContext,
  pk: string,
  key: string,
): Promise<string | undefined> {
  const existing = await withDynamoDBRetry(() =>
    context.client.get({
      TableName: context.tableName,
      Key: { PK: pk, SK: key },
      ProjectionExpression: '#c',
      ExpressionAttributeNames: { '#c': 'createdAt' },
    }),
  );
  return existing.Item?.createdAt as string | undefined;
}

/**
 * Store, update, or delete an item. A null value deletes; otherwise the value
 * is encoded (with optional compression/S3 offload), `createdAt` is preserved
 * across updates, and an embedding is computed when indexing is enabled.
 */
export async function putItem(context: StoreContext, op: PutOperation): Promise<void> {
  validateNamespace(op.namespace);
  validateKey(op.key);
  const pk = namespaceToPartition(op.namespace);
  if (op.value === null) {
    await withDynamoDBRetry(() =>
      context.client.delete({ TableName: context.tableName, Key: { PK: pk, SK: op.key } }),
    );
    return;
  }
  const value = op.value as Record<string, JsonValue>;
  const timestamp = nowIso();
  const createdAt = (await readCreatedAt(context, pk, op.key)) ?? timestamp;
  const embedding =
    op.index === false
      ? undefined
      : await embedValue(context, value, Array.isArray(op.index) ? op.index : undefined);
  const ttlTimestamp = context.ttl ? calculateTtlTimestamp(context.ttl) : undefined;
  const record = await buildStoreItem(context, op.namespace, op.key, value, {
    createdAt,
    updatedAt: timestamp,
    embedding,
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
}
