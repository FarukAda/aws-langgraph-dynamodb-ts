import { validationError } from '../errors/errors';

/** The adapter tags that scope GSI1, matching the partition-key tags. */
export type IndexTag = 'CHKPT' | 'STORE' | 'SESS';

/** The two attributes a row carries to appear in GSI1. */
export interface IndexKeys {
  gsi1pk: string;
  gsi1sk: string;
}

/** Default number of index partitions per adapter. */
export const DEFAULT_INDEX_SHARDS = 8;

/**
 * A stable 32-bit FNV-1a hash of `value`.
 *
 * Deterministic and dependency-free, which is what a shard assignment needs: a
 * row's index entry must be findable and deletable without a scan, so the same
 * id must always map to the same shard — across processes, releases and
 * machines. A cryptographic hash would cost more per write for a property
 * nothing here depends on.
 */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Refuse a shard count that would make the index unusable in either direction. */
function assertShardCount(shards: number): void {
  if (!Number.isInteger(shards) || shards < 1) {
    throw validationError(
      `indexShards must be a positive integer (received ${shards}); a non-positive value would ` +
        'make every row share one index partition or produce an unusable key',
      'indexShards',
    );
  }
}

/**
 * The GSI1 keys for a row that takes part in cross-partition listing.
 *
 * The partition key is the adapter tag plus a shard, because an index keyed by
 * the tag alone is one partition per adapter — a single hot partition, which is
 * worse than the table scan it replaces. AWS names the sharding requirement
 * directly: mapping one identifier onto one partition key "will quickly create
 * partition hot spots", and the answer is a secondary sharding model
 * (https://docs.aws.amazon.com/whitepapers/latest/multi-tenant-saas-storage-strategies/multitenancy-on-dynamodb.html).
 *
 * The sort key leads with an ISO-8601 timestamp, used unparsed: its byte order
 * already is its chronological order, so a recency listing is a key condition
 * rather than an in-memory sort. The row's own id follows it, which makes the
 * key total — two rows written in the same millisecond still order, so a cursor
 * can never loop.
 *
 * Accepts: `tag` — the adapter's. `id` — the row's own identifier, which
 * decides its shard and breaks ties in the sort key. `at` — an ISO-8601
 * instant. `shards` — index partitions per adapter, at least 1; fixed at table
 * creation, since changing it changes every row's shard and requires a
 * backfill.
 *
 * Returns: the two index attributes.
 *
 * Throws: ValidationError naming `indexShards` for a count below 1 — the read
 * side built an empty partition list from such a value and reported an empty
 * table full of rows.
 *
 * Guarantees: the same row always lands on the same shard, so a listing that
 * queries every shard sees every row exactly once.
 */
export function indexKeys(tag: IndexTag, id: string, at: string, shards: number): IndexKeys {
  assertShardCount(shards);
  return {
    gsi1pk: `${tag}#${fnv1a(id) % shards}`,
    gsi1sk: `${at}#${id}`,
  };
}

/**
 * Every index partition of one adapter.
 *
 * Accepts: `shards` — the same count the rows were written with; validated
 * here as it is in {@link indexKeys}, because a listing that silently queried
 * an empty partition list would return nothing for a table full of rows.
 *
 * Returns: one partition key per shard, which a recency listing queries in
 * parallel and merges.
 *
 * Throws: ValidationError naming `indexShards`.
 */
export function indexPartitions(tag: IndexTag, shards: number): string[] {
  assertShardCount(shards);
  return Array.from({ length: shards }, (_unused, shard) => `${tag}#${shard}`);
}
