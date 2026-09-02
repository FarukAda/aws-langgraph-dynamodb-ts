import type { Item } from '@langchain/langgraph-checkpoint';

import { PayloadLocation } from '../../shared/codec/codec';
import { isMissingObjectError } from '../../shared/codec/payload-loss';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { retryFor } from '../../shared/dynamodb/retry-policy';
import { narrowStoreRecord, readStoreItem } from '../internal/item-mapper';
import { partitionKey, sortKey } from '../internal/keys';
import type { StoreContext } from '../internal/setup';
import { validateStoreKey } from '../internal/validation';
import type { StoreItemRecord } from '../types';

/**
 * Read the row strongly consistently and narrow it rather than cast. A
 * foreign row sharing this key has no `namespace`, and one carrying a `value`
 * PayloadDescriptor in the same shape a store item uses (a checkpointer WRITE
 * row) would otherwise decode cleanly and be handed back as the caller's own
 * value.
 */
async function readRow(
  context: StoreContext,
  namespace: string[],
  key: string,
  signal?: AbortSignal,
): Promise<StoreItemRecord | undefined> {
  const result = await withDynamoDBRetry(
    () =>
      context.client.get({
        TableName: context.tableName,
        Key: { PK: partitionKey(namespace), SK: sortKey(namespace, key) },
        ConsistentRead: true,
      }),
    retryFor(context, signal),
  );
  if (!result.Item) return undefined;
  const record = narrowStoreRecord(result.Item);
  if (!record) {
    context.logger.warn('store.get: ignored a row that is not a store item', {
      partitionKey: partitionKey(namespace),
      sortKey: sortKey(namespace, key),
    });
  }
  return record;
}

/** True when both records point at the same offloaded object. */
function sameObject(a: StoreItemRecord, b: StoreItemRecord): boolean {
  return (
    a.value.location === PayloadLocation.S3 &&
    b.value.location === PayloadLocation.S3 &&
    a.value.s3Key === b.value.s3Key
  );
}

/**
 * Retrieve a single item by namespace and key (strongly consistent), or null.
 *
 * An offloaded item can lose a race with a concurrent overwrite: between the
 * row read and the S3 download the writer commits a new descriptor and deletes
 * the object this read was about to fetch. That surfaces as `NoSuchKey`, and
 * one strongly-consistent re-read settles it — the row now points at the new
 * object (return that), is gone (null), or still points at the same missing
 * object (a genuine loss, rethrown). Any other download failure propagates.
 */
export async function getItem(
  context: StoreContext,
  namespace: string[],
  key: string,
  signal?: AbortSignal,
): Promise<Item | null> {
  validateStoreKey(namespace, key);
  const record = await readRow(context, namespace, key, signal);
  if (!record) return null;
  try {
    return await readStoreItem(context, record);
  } catch (error) {
    if (!isMissingObjectError(error as Error)) throw error;
    const fresh = await readRow(context, namespace, key, signal);
    if (!fresh) return null;
    if (sameObject(record, fresh)) throw error;
    return readStoreItem(context, fresh);
  }
}
