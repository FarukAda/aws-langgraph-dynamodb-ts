import { randomUUID } from 'node:crypto';

import type { Item } from '@langchain/langgraph-checkpoint';

import { type CodecDeps, decodePayload } from '../../shared/codec/codec';
import { encodePayload } from '../../shared/codec/encode';
import type { DocItem } from '../../shared/dynamodb/client';
import { DEFAULT_INDEX_SHARDS, indexKeys } from '../../shared/dynamodb/index-keys';
import { assertReadableRow, ROW_FORMAT_VERSION } from '../../shared/dynamodb/table-schema';
import type { StoreItemRecord } from '../types';
import type { JsonValue } from './filter';
import { partitionKey, sortKey } from './keys';
import type { StoreContext } from './setup';

/**
 * Narrow a raw scanned row to a {@link StoreItemRecord}, or `undefined` for a
 * foreign row on a shared table (no `namespace`) — and for a row whose
 * `namespace`/`key` attributes disagree with the DynamoDB key it was found at.
 * The attributes name the S3 path the row may reference, so they must be bound
 * to the partition the row actually lives in: a writer confined to its own
 * partition can then never make a row speak for another tenant's objects.
 *
 * Accepts: `raw` — any row, whole or projected. The identity test reads only
 * `PK`, `SK`, `namespace` and `key`, and the version check reads only `v`,
 * which is what lets a namespace listing narrow rows it deliberately read
 * without their payload. A projection that leaves out `v` reads every row as
 * version 0, so the check cannot refuse one.
 *
 * Returns: the record, or undefined for a row that is not this adapter's item.
 *
 * Throws: `FORMAT_UNSUPPORTED` for a row a newer format version wrote —
 * checked **before** the shape, as every other read of this package's rows
 * checks it, so such a row is reported as newer rather than judged against
 * attribute names it may no longer use. Skipping it would hide an item that
 * exists.
 */
export function narrowStoreRecord(raw: DocItem): StoreItemRecord | undefined {
  /**
   * The version first. A later format may compose the row's key from
   * attributes this one does not know, so testing the shape first reads such a
   * row as foreign and hides an item that is there.
   */
  assertReadableRow(raw, 'store item');
  if (!Array.isArray(raw.namespace) || typeof raw.key !== 'string') return undefined;
  const record = raw as StoreItemRecord;
  const consistent =
    record.PK === partitionKey(record.namespace) &&
    record.SK === sortKey(record.namespace, record.key);
  return consistent ? record : undefined;
}

/**
 * The same narrowing for a call site that needs the *whole* row, not just its
 * identity: {@link readStoreItem} reads the timestamps as well as the payload,
 * and a row that carries none made `new Date(undefined)` — an `Invalid Date`
 * handed back under a declared `Date`, which surfaces as a `RangeError` in the
 * caller's own code, far from the row that caused it.
 *
 * It is a separate narrow rather than a stricter {@link narrowStoreRecord}
 * because a namespace listing deliberately reads rows without their timestamps
 * (see `projectKeys`): requiring one there would hide every namespace in the
 * table.
 *
 * Accepts: `raw` — any whole row, as read by `get`, a search or a reconcile.
 *
 * Returns: the record, or undefined for a row {@link narrowStoreRecord}
 * refuses and for one whose `createdAt` or `updatedAt` is not the string this
 * package writes there. A row this adapter cannot describe is skipped where a
 * foreign one already is, so one of them never costs a listing the rest of its
 * rows.
 *
 * Throws: as {@link narrowStoreRecord}.
 */
export function narrowWholeRecord(raw: DocItem): StoreItemRecord | undefined {
  const record = narrowStoreRecord(raw);
  if (record === undefined) return undefined;
  const stamped = typeof record.createdAt === 'string' && typeof record.updatedAt === 'string';
  return stamped ? record : undefined;
}

/**
 * Map a store context to the codec collaborators, plus the caller's `signal`
 * where the call takes one. The write path passes none, because no store write
 * accepts a signal.
 */
function storeCodecDeps(context: StoreContext, signal?: AbortSignal): CodecDeps {
  return {
    serde: context.serde,
    compression: context.compression,
    offloader: context.offloader,
    signal,
  };
}

/** Fields controlling a stored item's timestamps, embeddings, ttl and revision token. */
export interface BuildItemOptions {
  createdAt: string;
  updatedAt: string;
  embeddings?: number[][];
  ttlTimestamp?: number;
  /**
   * The row's revision token, unique per `put` call. It is the value a
   * concurrent overwrite pins with a compare-and-swap, so each writer can tell
   * whether the row it read is still the row it is replacing, and it is the
   * object id an offloaded value is uploaded under. A fresh UUID is drawn when
   * it is absent.
   */
  rev?: string;
}

/**
 * Encode a value into the DynamoDB record for a stored item.
 *
 * Accepts: `namespace` and `key` — already validated; they become the row's key
 * and, with it, the S3 path any offloaded payload may occupy. `value` — a value
 * the serializer can represent. `options.rev` — this put's own revision token,
 * which the compare-and-swap pins, the write verification reads back, and an
 * offloaded value's key ends in; absent, a fresh UUID is drawn, before the
 * value is encoded.
 *
 * Returns: the complete row, including the recency-index attributes: a store
 * item is listed across partitions by a rootless search, so it is indexed.
 *
 * Throws: `VALIDATION` naming `value` for a value with no JSON
 * representation; `S3_OFFLOAD_FAILED` when an offloaded payload cannot be
 * uploaded. Encoding happens before any write, so a value that cannot be stored
 * never half-writes a row.
 */
export async function buildStoreItem(
  context: StoreContext,
  namespace: string[],
  key: string,
  value: Record<string, JsonValue>,
  options: BuildItemOptions,
): Promise<StoreItemRecord> {
  const pk = partitionKey(namespace);
  const sk = sortKey(namespace, key);
  const rev = options.rev ?? randomUUID();
  const descriptor = await encodePayload(value, storeCodecDeps(context), {
    keyParts: [...namespace, key],
    objectId: rev,
    row: { pk, sk },
  });
  /** Store items are listed across partitions by a rootless search, so they are indexed. */
  const index = indexKeys(
    'STORE',
    sk,
    options.updatedAt,
    context.indexShards ?? DEFAULT_INDEX_SHARDS,
  );
  const record: StoreItemRecord = {
    PK: pk,
    SK: sk,
    v: ROW_FORMAT_VERSION,
    ...index,
    namespace,
    key,
    value: descriptor,
    createdAt: options.createdAt,
    updatedAt: options.updatedAt,
    rev,
  };
  if (options.embeddings) record.embeddings = options.embeddings;
  if (options.ttlTimestamp !== undefined) record.ttl = options.ttlTimestamp;
  return record;
}

/**
 * Decode a DynamoDB record back into a store {@link Item}.
 *
 * Accepts: `record` — a whole row, never a projection: the value and the
 * timestamps are read from it, and `projectKeys` rows exist only to establish
 * identity for a namespace listing. {@link narrowWholeRecord} is what proves a
 * raw row is one of those, timestamps included. `signal` — cancels the
 * download an offloaded value costs.
 *
 * Returns: the item, with the timestamps this library stamped at write time.
 *
 * Throws: `PAYLOAD_CORRUPT` for a payload that cannot be decoded,
 * `VALIDATION` naming `serde` for one the configured serde refuses to
 * reconstruct, and whatever the download throws for an offloaded one —
 * including the missing-object error `getItem` resolves against a concurrent
 * overwrite.
 */
export async function readStoreItem(
  context: StoreContext,
  record: StoreItemRecord,
  signal?: AbortSignal,
): Promise<Item> {
  const value = await decodePayload<Record<string, JsonValue>>(
    record.value,
    storeCodecDeps(context, signal),
    [...record.namespace, record.key],
  );
  return {
    namespace: record.namespace,
    key: record.key,
    value,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}
