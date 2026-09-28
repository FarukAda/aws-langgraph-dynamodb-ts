/**
 * Hides the store's key layout and how an item becomes a row and back.
 *
 * An item's namespace root is its partition and the rest of its namespace,
 * with its key, is its sort key, so a prefix search is a key-range query. How
 * those keys are composed, which attributes a row carries — its revision token,
 * timestamps, embeddings, recency-index keys — how a value is encoded into one
 * and decoded out, and which rows a read admits as this adapter's items are
 * decided here.
 */

import { randomUUID } from 'node:crypto';

import type { QueryCommandInput, ScanCommandInput } from '@aws-sdk/lib-dynamodb';
import type { Item } from '@langchain/langgraph-checkpoint';

import {
  codecDepsOf,
  decodePayload,
  type DescriptorRef,
  encodePayload,
  type PayloadDescriptor,
} from '../../shared/codec/codec';
import type { AttributeMap } from '../../shared/dynamodb/client';
import {
  backfilledAt,
  DEFAULT_INDEX_SHARDS,
  indexKeys,
  type IndexTarget,
} from '../../shared/dynamodb/recency-index';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import {
  ADAPTER_TAGS,
  assertReadableRow,
  KEY_SEPARATOR,
  PARTITION_KEY_ATTRIBUTE,
  ROW_FORMAT_VERSION,
  type RowKey,
  SORT_KEY_ATTRIBUTE,
} from '../../shared/dynamodb/table-schema';
import type { JsonValue } from './filter';
import type { StoreContext } from './setup';

/**
 * The attribute an item row carries its revision token in, rewritten on every
 * put. A put's compare-and-swap and a delete's pin both hold the row to the
 * token they observed.
 */
export const REVISION_ATTRIBUTE = 'rev';

/**
 * Adapter tag prefixed to every store partition key — see the equivalent in
 * checkpointer/internal/rows.ts for why the three adapters' partitions must
 * not overlap on a shared table.
 */
const ADAPTER_PARTITION_PREFIX = `${ADAPTER_TAGS.store}${KEY_SEPARATOR}`;

/**
 * The tag every store partition key starts with.
 *
 * Accepts: nothing — the tag is fixed, and the function exists so no caller
 * composes it by hand.
 *
 * Returns: the tag, for a table-wide `begins_with` over this adapter's rows.
 *
 * Throws: nothing.
 */
export function storePartitionPrefix(): string {
  return ADAPTER_PARTITION_PREFIX;
}

/**
 * Partition key for an item: the adapter tag plus the scope-root element.
 *
 * Accepts: `namespace` — normally a validated one, whose first element is the
 * scope root every item under it shares.
 *
 * Returns: the partition key. The function is deliberately **total**: it maps
 * any array to a string rather than refusing a malformed one, because
 * `parseStoreRow` calls it on rows read from a shared table to test whether
 * a row's own attributes agree with the key it was found at. A corrupt or
 * foreign row must be skipped there, not turned into a failed search.
 *
 * Throws: nothing.
 */
export function partitionKey(namespace: string[]): string {
  return `${ADAPTER_PARTITION_PREFIX}${namespace[0]}`;
}

/**
 * Sort key: the rest of the namespace plus the key, separator-joined.
 *
 * Accepts: `namespace` and `key` — normally validated, so no element can itself
 * contain the separator and the join is unambiguous. A one-element namespace
 * lives entirely in the partition key, so the sort key is just `key`.
 *
 * Returns: the sort key. Total, for the same reason as {@link partitionKey}.
 *
 * Throws: nothing.
 */
export function sortKey(namespace: string[], key: string): string {
  return [...namespace.slice(1), key].join(KEY_SEPARATOR);
}

/**
 * `begins_with` prefix selecting a scoped subtree within `prefix[0]`'s
 * partition.
 *
 * Accepts: `prefix` — its first element selects the partition and is not part
 * of the sort key, so a one-element prefix has no rest to match on.
 *
 * Returns: the prefix, separator-terminated so `['users','u1']` does not also
 * match a sibling like `u10`; `''` when there is no rest, which matches the
 * whole partition.
 *
 * Throws: nothing.
 */
export function sortKeyPrefix(prefix: string[]): string {
  const rest = prefix.slice(1);
  return rest.length === 0 ? '' : `${rest.join(KEY_SEPARATOR)}${KEY_SEPARATOR}`;
}

/**
 * Whether `namespace` starts with `prefix`, element by element.
 *
 * Accepts: any two namespaces; an empty prefix matches everything, and a prefix
 * longer than the namespace matches nothing.
 *
 * Returns: whether every prefix element equals the namespace element at the
 * same position — not a string comparison, so `['userspace']` does not match the
 * prefix `['users']`.
 *
 * Throws: nothing.
 */
export function namespaceMatchesPrefix(namespace: string[], prefix: string[]): boolean {
  if (prefix.length > namespace.length) return false;
  return prefix.every((element, index) => namespace[index] === element);
}

/**
 * The key of an item's row.
 *
 * Accepts: `address` — the item's namespace and key, parsed, or read back from
 * a row or a vector backend's answer.
 *
 * Returns: the row's partition and sort key.
 *
 * Throws: nothing.
 */
export function itemRowKey(address: { namespace: string[]; key: string }): RowKey {
  return { PK: partitionKey(address.namespace), SK: sortKey(address.namespace, address.key) };
}

/**
 * Query input for a scoped prefix.
 *
 * Accepts: `prefix` — at least one element; the first selects the partition and
 * the rest, when there are any, become a `begins_with` on the sort key. Callers
 * decide the rootless case before reaching here: an empty prefix spans every
 * partition, which is a Scan ({@link storeScan}), not a Query.
 *
 * Returns: the Query input. The `begins_with` prefix is separator-terminated,
 * so the scope `['users', 'u1']` does not also read `u10`.
 *
 * Throws: nothing.
 */
export function scopedQuery(tableName: string, prefix: string[]): QueryCommandInput {
  const skPrefix = sortKeyPrefix(prefix);
  if (skPrefix.length === 0) {
    return {
      TableName: tableName,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': PARTITION_KEY_ATTRIBUTE },
      ExpressionAttributeValues: { ':pk': partitionKey(prefix) },
    };
  }
  return {
    TableName: tableName,
    KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :skp)',
    ExpressionAttributeNames: { '#pk': PARTITION_KEY_ATTRIBUTE, '#sk': SORT_KEY_ATTRIBUTE },
    ExpressionAttributeValues: { ':pk': partitionKey(prefix), ':skp': skPrefix },
  };
}

/**
 * Scan input for the rootless case, filtered to store items only.
 *
 * Accepts: the table name. There is nothing to scope by — this is the read for
 * a search or listing whose conditions name no concrete partition.
 *
 * Returns: the Scan input, selecting this adapter's **key space** first and its
 * rows within it second. `begins_with(PK, 'STORE#')` is what restricts the
 * read: every store row carries that tag and no other adapter's partition key
 * can, so a row belonging to another adapter or to another application never
 * reaches the narrow. The `namespace` test stays behind it as a second line of
 * defence over the store's own partitions.
 *
 * Selecting on the attribute alone was not equivalent. It admitted any row on a
 * shared table that happens to carry a `namespace` attribute, and since a row
 * stamped with a format version above this release is *reported* rather than
 * skipped, one foreign row was enough to fail `search([])` and
 * `listNamespaces()` outright. Nothing legitimate is lost: `parseStoreRow`
 * already requires `PK` to equal `partitionKey(namespace)`, which carries the
 * same tag, so every row the tag excludes was dropped after the read anyway.
 *
 * The extra condition is free. A filter "is applied after a `Scan` finishes but
 * before the results are returned. Therefore, a `Scan` consumes the same amount
 * of read capacity, regardless of whether a filter expression is present"
 * (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Scan.html).
 * It saves transfer, not RCU — which is also why it cannot replace the narrow.
 *
 * Throws: nothing.
 */
export function storeScan(tableName: string): ScanCommandInput {
  return {
    TableName: tableName,
    FilterExpression: 'begins_with(#pk, :pkp) AND attribute_exists(#ns)',
    ExpressionAttributeNames: { '#pk': PARTITION_KEY_ATTRIBUTE, '#ns': 'namespace' },
    ExpressionAttributeValues: { ':pkp': storePartitionPrefix() },
  };
}

/**
 * Restrict a Query/Scan to the attributes `parseStoreRow` needs, leaving the
 * payload behind: a namespace listing never reads a value.
 *
 * Accepts: any Query or Scan input; its own attribute names are preserved and
 * the projection's are added.
 *
 * Returns: the same input, projected onto the row's identity and its format
 * version `v`. The version is what lets `parseStoreRow` refuse a row a
 * newer release wrote; without it every projected row reads as version 0. A
 * row read this way can be narrowed but not decoded — {@link readStoreItem}
 * needs the whole row.
 *
 * Throws: nothing.
 *
 * Guarantees: RCU is billed on the stored size regardless, so the saving is
 * transfer and unmarshalling, not cost.
 */
export function projectKeys<T extends QueryCommandInput | ScanCommandInput>(params: T): T {
  return {
    ...params,
    ProjectionExpression: `${PARTITION_KEY_ATTRIBUTE}, ${SORT_KEY_ATTRIBUTE}, #ns, #key, #v`,
    ExpressionAttributeNames: {
      ...params.ExpressionAttributeNames,
      '#ns': 'namespace',
      '#key': 'key',
      '#v': 'v',
    },
  };
}

/** The previous row's createdAt, payload descriptor and revision. */
export interface ExistingRowMeta {
  exists: boolean;
  createdAt?: string;
  value?: DescriptorRef;
  revision?: string;
}

/**
 * Read the fields a put needs from the row it is about to replace, in one
 * strongly-consistent projection: `createdAt` to preserve, the descriptor's
 * location and S3 key to clean up afterwards (never its inline bytes, which
 * can be hundreds of kilobytes the write would only discard), and the
 * revision the compare-and-swap pins.
 *
 * Lives apart from `actions/put.ts` so `item-write.ts` can re-read on a lost swap
 * without importing its own caller.
 *
 * Accepts: `key` — the row's key. The row need not exist.
 *
 * Returns: what the row holds, with `exists: false` and every field undefined
 * when there is none. A row written before revisions existed reports no
 * `revision`, which is why the swap tests `rev` for presence rather than
 * comparing two undefineds.
 *
 * Throws: whatever the read throws after retries.
 *
 * Guarantees: strongly consistent — a put must supersede the row that is really
 * there, not one a replica still shows.
 */
export async function readExisting(context: StoreContext, key: RowKey): Promise<ExistingRowMeta> {
  const existing = await withDynamoDBRetry(
    (request) =>
      context.client.get(
        {
          TableName: context.tableName,
          Key: key,
          ConsistentRead: true,
          ProjectionExpression: '#c, #r, #v.#loc, #v.#s3k',
          ExpressionAttributeNames: {
            '#c': 'createdAt',
            '#r': REVISION_ATTRIBUTE,
            '#v': 'value',
            '#loc': 'location',
            '#s3k': 's3Key',
          },
        },
        request,
      ),
    context.retry,
  );
  return existingFrom(existing.Item as AttributeMap | undefined);
}

/**
 * Project a raw row onto {@link ExistingRowMeta}.
 *
 * Accepts: `item` — a read result, or the row a conditional-check rejection
 * carried with it; `undefined` means there is no row.
 *
 * Returns: the fields a put needs from the row it supersedes. Fields the
 * projection did not ask for, or that the row does not carry, are undefined.
 *
 * Throws: nothing.
 */
export function existingFrom(item: AttributeMap | undefined): ExistingRowMeta {
  return {
    exists: item !== undefined,
    createdAt: item?.createdAt as string | undefined,
    value: item?.value as DescriptorRef | undefined,
    revision: item?.[REVISION_ATTRIBUTE] as string | undefined,
  };
}

/** The DynamoDB item backing a single stored value. */
export interface StoreItemRow {
  PK: string;
  SK: string;
  /** Row format version; absent on rows written before it existed (see `table-schema.ts`). */
  v?: number;
  /** Recency-index keys; absent on rows written before the index existed. */
  gsi1pk?: string;
  gsi1sk?: string;
  namespace: string[];
  key: string;
  value: PayloadDescriptor;
  createdAt: string;
  updatedAt: string;
  /**
   * One vector per extracted path, scored by best match on read. Absent when
   * the value has no indexable text, or when a `vectorBackend` holds the
   * vectors instead.
   */
  embeddings?: number[][];
  /**
   * The single joined vector rows carried before the store embedded each path
   * separately. Never written now; still read, and scored as a one-element
   * list, so rows written by an earlier version rank exactly as they did.
   */
  embedding?: number[];
  ttl?: number;
  /**
   * Revision token, rewritten on every put. Pins the compare-and-swap that
   * keeps two concurrent overwrites from both deleting the same superseded S3
   * object. Optional: rows written before 0.9.0 carry none.
   */
  rev?: string;
}

/**
 * Narrow a raw scanned row to a {@link StoreItemRow}, or `undefined` for a
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
export function parseStoreRow(raw: AttributeMap): StoreItemRow | undefined {
  // The version first. A later format may compose the row's key from
  // attributes this one does not know, so testing the shape first reads such a
  // row as foreign and hides an item that is there.
  assertReadableRow(raw, 'store item');
  if (!Array.isArray(raw.namespace) || typeof raw.key !== 'string') return undefined;
  const record = raw as StoreItemRow;
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
 * It is a separate narrow rather than a stricter {@link parseStoreRow}
 * because a namespace listing deliberately reads rows without their timestamps
 * (see `projectKeys`): requiring one there would hide every namespace in the
 * table.
 *
 * Accepts: `raw` — any whole row, as read by `get`, a search or a reconcile.
 *
 * Returns: the record, or undefined for a row {@link parseStoreRow}
 * refuses and for one whose `createdAt` or `updatedAt` is not the string this
 * package writes there. A row this adapter cannot describe is skipped where a
 * foreign one already is, so one of them never costs a listing the rest of its
 * rows.
 *
 * Throws: as {@link parseStoreRow}.
 */
export function parseWholeStoreRow(raw: AttributeMap): StoreItemRow | undefined {
  const record = parseStoreRow(raw);
  if (record === undefined) return undefined;
  const stamped = typeof record.createdAt === 'string' && typeof record.updatedAt === 'string';
  return stamped ? record : undefined;
}

/** Fields controlling a stored item's timestamps, embeddings, ttl and revision token. */
export interface BuildRowOptions {
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
 * Accepts: `address` — already validated; its `namespace` and `key` become the
 * row's key and, with it, the S3 path any offloaded payload may occupy.
 * `value` — a value the serializer can represent. `options.rev` — this put's
 * own revision token, which the compare-and-swap pins, the write verification
 * reads back, and an offloaded value's key ends in; absent, a fresh UUID is
 * drawn, before the value is encoded.
 *
 * Returns: the complete row, including the recency-index attributes: a store
 * item is listed across partitions by a rootless search, so it is indexed.
 *
 * Throws: `VALIDATION` naming `value` for a value with no JSON
 * representation, or `payload` for one too large to store inline without
 * `s3`, or, once offloaded, larger than `s3.maxDownloadBytes`;
 * `S3_OFFLOAD_FAILED` when an offloaded payload cannot be uploaded. Encoding
 * happens before any write, so a value that cannot be stored never
 * half-writes a row.
 */
export async function buildStoreRow(
  context: StoreContext,
  address: { namespace: string[]; key: string },
  value: Record<string, JsonValue>,
  options: BuildRowOptions,
): Promise<StoreItemRow> {
  const { namespace, key } = address;
  const pk = partitionKey(namespace);
  const sk = sortKey(namespace, key);
  const rev = options.rev ?? randomUUID();
  const descriptor = await encodePayload(value, codecDepsOf(context), {
    keyParts: [...namespace, key],
    objectId: rev,
    row: { pk, sk },
  });
  // Store items are listed across partitions by a rootless search, so they are indexed.
  const index = indexKeys(
    'STORE',
    sk,
    options.updatedAt,
    context.indexShards ?? DEFAULT_INDEX_SHARDS,
  );
  const record: StoreItemRow = {
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
 * identity for a namespace listing. {@link parseWholeStoreRow} is what proves a
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
  record: StoreItemRow,
  signal?: AbortSignal,
): Promise<Item> {
  const value = await decodePayload<Record<string, JsonValue>>(
    record.value,
    codecDepsOf(context, signal),
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

/**
 * Where a store row sits in the recency index, for a row written before the
 * index existed.
 *
 * Accepts: `row` — any row of the table.
 *
 * Returns: an item row's identity — its sort key, at its own `updatedAt` — or
 * `undefined` for a row of another adapter.
 *
 * Throws: nothing.
 */
export function storeIndexTarget(row: AttributeMap): IndexTarget | undefined {
  const pk = typeof row.PK === 'string' ? row.PK : '';
  const sk = typeof row.SK === 'string' ? row.SK : '';
  if (!pk.startsWith(storePartitionPrefix())) return undefined;
  return { tag: 'STORE', id: sk, at: backfilledAt(row.updatedAt) };
}
