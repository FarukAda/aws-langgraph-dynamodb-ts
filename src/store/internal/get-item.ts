import type { Item } from '@langchain/langgraph-checkpoint';

import { nowSeconds } from '../../shared/clock';
import { PayloadLocation } from '../../shared/codec/codec';
import type { DescriptorRef } from '../../shared/codec/descriptor-keys';
import { isMissingObjectError } from '../../shared/codec/payload-loss';
import { withDynamoDBRetry, retryFor } from '../../shared/dynamodb/retry';
import { isExpiredRow } from '../../shared/dynamodb/table-schema';
import type { StoreAddress } from './parse';
import {
  itemRowKey,
  narrowWholeRecord,
  partitionKey,
  readStoreItem,
  sortKey,
  type StoreItemRecord,
} from './rows';
import type { StoreContext } from './setup';

/**
 * Read the row strongly consistently and narrow it rather than cast. A
 * foreign row sharing this key has no `namespace`, and one carrying a `value`
 * PayloadDescriptor in the same shape a store item uses (a checkpointer WRITE
 * row) would otherwise decode cleanly and be handed back as the caller's own
 * value. The narrow is the whole-row one, so a row with no `createdAt` or
 * `updatedAt` is refused here rather than decoded into an item whose
 * timestamps are `Invalid Date`.
 */
async function readRow(
  context: StoreContext,
  namespace: string[],
  key: string,
  signal?: AbortSignal,
): Promise<StoreItemRecord | undefined> {
  const result = await withDynamoDBRetry(
    (request) =>
      context.client.get(
        {
          TableName: context.tableName,
          Key: itemRowKey({ namespace, key }),
          ConsistentRead: true,
        },
        request,
      ),
    retryFor(context, signal),
  );
  if (!result.Item) return undefined;
  const record = narrowWholeRecord(result.Item);
  if (!record) {
    context.logger.warn('store.get: ignored a row that is not a store item', {
      partitionKey: partitionKey(namespace),
      sortKey: sortKey(namespace, key),
    });
    return undefined;
  }
  /** A row past its ttl is absent to every reader, however long DynamoDB's sweep lags. */
  return isExpiredRow(record, nowSeconds()) ? undefined : record;
}

/**
 * True when both records point at the same offloaded object.
 *
 * Only `read` is known to hold a descriptor: it is the row whose download just
 * failed. `reread` is whatever the overwrite this recovery exists for left
 * behind, which can be a `null` where the descriptor belongs, so it is tested
 * for presence first. A row pointing at nothing is not pointing at the object
 * this read lost, so it is decoded like any other replacement and answered with
 * the coded error that names the descriptor — not with a property read that
 * would replace the download's own failure with a bare `TypeError`.
 */
function sameObject(read: StoreItemRecord, reread: StoreItemRecord): boolean {
  const fresh: DescriptorRef | undefined = reread.value;
  if (!fresh) return false;
  return (
    read.value.location === PayloadLocation.S3 &&
    fresh.location === PayloadLocation.S3 &&
    read.value.s3Key === fresh.s3Key
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
 * object (a genuine loss, rethrown). A row the overwrite left with no
 * descriptor at all is a replacement like any other: it is decoded, and refused
 * by its own coded error. Any other download failure propagates.
 *
 * Accepts: `address` — parsed; no check is repeated here. `signal` — aborts
 * the reads.
 *
 * Returns: the item, or `null` for one that does not exist, has expired, or
 * whose key holds a row this adapter does not own — which includes a row whose
 * `createdAt` or `updatedAt` is not the string this package writes there, since
 * an item is reported with both. The answers are one on purpose: a caller
 * cannot act on the difference, and reporting a foreign row would leak that a
 * shared table holds one.
 *
 * Throws: `VALIDATION` naming — for a row whose descriptor is not one —
 * `descriptor`; `FORMAT_UNSUPPORTED` for
 * a row, or a payload, written by a newer version, which is *not* reported as
 * absent — hiding an item that exists is worse than failing; `PAYLOAD_CORRUPT`
 * or the download's own error for a payload that cannot be read; `ABORTED`
 * when the signal fires.
 *
 * Guarantees: strongly consistent — an item just written is always seen, and
 * the ttl is honoured here rather than waited for.
 */
export async function getItem(
  context: StoreContext,
  address: StoreAddress,
  signal?: AbortSignal,
): Promise<Item | null> {
  const { namespace, key } = address;
  const record = await readRow(context, namespace, key, signal);
  if (!record) return null;
  try {
    return await readStoreItem(context, record, signal);
  } catch (error) {
    if (!isMissingObjectError(error as Error)) throw error;
    const fresh = await readRow(context, namespace, key, signal);
    if (!fresh) return null;
    if (sameObject(record, fresh)) throw error;
    return readStoreItem(context, fresh, signal);
  }
}
