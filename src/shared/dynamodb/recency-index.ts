/**
 * Hides the recency index (record 8).
 *
 * A row that a cross-partition listing reaches carries two index keys: a
 * partition that hashes its identity onto one of a fixed number of shards, and
 * a sort key that orders it by time. A listing reads every shard at once,
 * merges them newest first, and hands out an opaque cursor that resumes the
 * merge. The shard function, the key format and the merge are decided here.
 */

import type { QueryCommandInput } from '@aws-sdk/lib-dynamodb';

import { mapWithConcurrency } from '../concurrency';
import { validationError, resultTruncatedError } from '../errors/errors';
import { type PageLimit, parseLimit } from '../validation/primitives';
import type { DocItem, DynamoDBDocumentLike } from './client';
import { MAX_LOOP_ITERATIONS } from './paginate';
import { type RetryOptions, withDynamoDBRetry } from './retry';
import { compareSortKeys } from './table-schema';

/** One page of a recency listing, and where the next one resumes. */
export interface IndexPage {
  items: DocItem[];
  /** Absent when the page is the last one. */
  nextCursor?: string;
}

/**
 * A cursor is the sort key of the last row handed out.
 *
 * That is all it needs to be: `gsi1sk` is `<timestamp>#<id>`, which is unique
 * and totally ordered, so the next page is simply "everything below this". It
 * is also why the cursor is not a `LastEvaluatedKey` — one per shard would have
 * to be carried, and a shard count change would silently invalidate them.
 * Opaque to the caller all the same: its shape is not a promise.
 *
 * The key handed here is always the last row {@link takeNewest} chose, and
 * that is the only reason the cursor is sound: the merge hands rows out in
 * descending {@link compareSortKeys} order, so the last one is the smallest
 * key on the page in the server's own order, which is exactly what
 * `#sk < :before` resumes below. There is no second comparison to keep in step
 * — one comparator decides the order, and the cursor is a row it chose.
 */
function encodeCursor(sortKey: string): string {
  return Buffer.from(sortKey, 'utf8').toString('base64url');
}

/**
 * The sort key a cursor encodes.
 *
 * Accepts: `cursor` — as a previous page returned it.
 *
 * Returns: the `gsi1sk` to resume below.
 *
 * Throws: `VALIDATION` naming `cursor` when the decoded value carries no
 * `#`. `gsi1sk` is `<timestamp>#<id>`, so such a value was issued by something
 * else — a scan cursor, a page token from another API — and using it as a bound
 * would quietly return the wrong page rather than say so. A value that carries
 * a `#` is not checked further.
 */
function decodeCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!decoded.includes('#')) {
    throw validationError('cursor is not one this adapter issued', 'cursor');
  }
  return decoded;
}

/** A shard with no row to offer that may still hold one. */
function isDry(reader: ShardReader): boolean {
  return reader.buffer.length === 0 && !reader.exhausted;
}

/**
 * Read the next page of every dry shard, at most `concurrency` at once, until
 * no shard is dry. A page can hold no rows and still carry a key, and a shard
 * in that state may hold the newest row of all, so choosing a row before it is
 * read again could put an older row on the page first.
 *
 * The loop carries no iteration cap of its own, and that is a decision rather
 * than an omission. Every pass calls {@link readShardPage} on every dry shard,
 * and that call either advances the shard or, once the shard has read
 * `MAX_LOOP_ITERATIONS` pages, throws `RESULT_TRUNCATED` without issuing a
 * query — so a shard that answers with empty pages forever ends the listing
 * there. A second cap here could only ever fire after that one, which makes it
 * a branch no test could reach. What did once spin was a `mapWithConcurrency`
 * that started zero workers for a non-integer `concurrency`: the call returned
 * having read nothing, so no shard advanced and no page count grew. The fix
 * belongs there, in the floor that now cannot yield zero workers, and not in a
 * cap papering over a collaborator that silently did nothing.
 */
async function refillDryShards(
  options: IndexQueryOptions,
  readers: ShardReader[],
  before: string | undefined,
  needed: number,
): Promise<void> {
  for (let dry = readers.filter(isDry); dry.length > 0; dry = readers.filter(isDry)) {
    await mapWithConcurrency(dry, options.concurrency, (reader) =>
      readShardPage(options, reader, before, needed),
    );
  }
}

/**
 * Move the newest buffered row off its shard; undefined when every buffer is
 * empty.
 *
 * "Newest" is {@link compareSortKeys}, not `>`: the row this picks is the one
 * the resumed `#sk < :before` query will agree is newest, and the two orders
 * part company at an astral id. `''` is a safe starting bound because a
 * DynamoDB key attribute is never the empty string, so no row can lose to it.
 */
function takeNewest(readers: ShardReader[]): DocItem | undefined {
  let newest: ShardReader | undefined;
  let newestKey = '';
  for (const reader of readers) {
    const head = reader.buffer[reader.buffer.length - 1];
    if (head !== undefined && compareSortKeys(head.gsi1sk as string, newestKey) > 0) {
      newest = reader;
      newestKey = head.gsi1sk as string;
    }
  }
  return newest?.buffer.pop();
}

/**
 * Read one page of a recency listing from the index, newest first.
 *
 * Each shard is read one DynamoDB page at a time and the pages are merged row
 * by row: the newest buffered row goes onto the page, and a shard whose buffer
 * runs dry reads its next page before another row is chosen. That is correct
 * because each shard is already sorted and no row is chosen while a shard that
 * may hold a newer one is unread. It is also what bounds memory: a listing
 * holds the page it is building, up to `limit` rows, plus at most one DynamoDB
 * page per shard, and a shard none of whose buffered rows the page takes is
 * never followed. The price is that a dry shard is read again whenever the page
 * still needs a row, even when every row still to come is another shard's,
 * which can cost a query per shard per page whose rows the page never takes.
 * The alternative — one query over an unsharded index — would make every
 * listing hit one partition, which is what the sharding exists to avoid.
 *
 * This replaces a full-table `Scan` with a `FilterExpression`, which consumed
 * read capacity for every row *evaluated*, collected the whole table in memory
 * and sorted it there.
 *
 * Accepts: `limit` — a `PageLimit`, already checked against the package-wide
 * page rule by the caller's parser. `0` returns an empty page with no cursor
 * and issues no query — and is answered here rather than left to the merge,
 * where an empty page with shards still unread would have read
 * `items[items.length - 1]` off an empty array to build the cursor. `cursor`
 * — from a previous page, or none to start at the newest. `shards` — must
 * match what the writers used. `concurrency` — how many shards are queried at
 * once.
 *
 * Returns: the page, newest first, and a `nextCursor` exactly while rows may
 * remain: a shard still buffers a row the page did not take, or has not
 * reported its end. A cursor is never withheld while rows remain, and none is
 * issued once every shard has reported its end, even for a page filled
 * exactly. DynamoDB can still report a `LastEvaluatedKey` on a page that ends
 * at a shard's last row, so the page after such a cursor may come back empty.
 *
 * Throws: `VALIDATION` naming `cursor`; `RESULT_TRUNCATED`
 * for a shard whose pages do not end within `MAX_LOOP_ITERATIONS`; whatever
 * the queries throw, including an `ABORTED` error.
 *
 * Guarantees: at most `concurrency` shards are queried at once; each shard is
 * followed across DynamoDB's 1 MB page boundary, but its next page is read only
 * when its buffer is empty and the page still needs a row, so besides the page
 * being built, up to `limit` rows, no more than one DynamoDB page per shard is
 * held at a time.
 */
export async function queryRecencyIndex(options: IndexQueryOptions): Promise<IndexPage> {
  if (options.limit === 0) return { items: [] };
  const before = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
  const readers = indexPartitions(options.tag, options.shards).map((partition) =>
    shardReader(partition),
  );
  const items: DocItem[] = [];
  while (items.length < options.limit) {
    await refillDryShards(options, readers, before, options.limit - items.length);
    const row = takeNewest(readers);
    if (row === undefined) break;
    items.push(row);
  }
  /**
   * Rows remain when a shard still buffers a row or has not reported its end.
   * Either way the loop stopped on a full page, so the page is non-empty and
   * its last row is the right place to resume.
   */
  const remain = readers.some((reader) => reader.buffer.length > 0 || !reader.exhausted);
  return {
    items,
    ...(remain ? { nextCursor: encodeCursor(items[items.length - 1].gsi1sk as string) } : {}),
  };
}

/** Rows per page when a caller streams the whole index rather than paging it. */
const STREAM_PAGE_SIZE: PageLimit = parseLimit(100, 0);

/**
 * Every row of one adapter's recency index, newest first, page by page.
 *
 * The streaming counterpart of {@link queryRecencyIndex}, for a caller that
 * consumes rows until it has what it needs and then stops. It replaces a
 * full-table `Scan` whose cost scaled with the table rather than with the
 * answer.
 *
 * Accepts: as {@link queryRecencyIndex}, without `limit` and `cursor` — this
 * walks the whole index, paging internally.
 *
 * Returns: an async generator over every row, newest first. An early `break`
 * fetches no further page, so a caller that needs ten rows of a large index
 * pays for one page.
 *
 * Throws: as {@link queryRecencyIndex}.
 */
export async function* iterateRecencyIndex(
  options: Omit<IndexQueryOptions, 'limit' | 'cursor'>,
): AsyncGenerator<DocItem> {
  let cursor: string | undefined;
  do {
    const page = await queryRecencyIndex({ ...options, limit: STREAM_PAGE_SIZE, cursor });
    for (const item of page.items) yield item;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
}

/** The adapter tags that scope GSI1, matching the partition-key tags. */
export type IndexTag = 'CHKPT' | 'STORE' | 'SESS';

/** How a row appears in the recency index: its adapter's tag, its identity, and its time. */
export interface IndexTarget {
  tag: IndexTag;
  id: string;
  at: string;
}

/** The time a row that recorded none is indexed at, older than anything indexed since. */
export const BACKFILLED_AT = '1970-01-01T00:00:00.000Z';

/**
 * The time a backfilled row is indexed at.
 *
 * Accepts: `recorded` — the row's own time attribute, whatever it holds.
 *
 * Returns: that time when it is a string, else {@link BACKFILLED_AT}.
 *
 * Throws: nothing.
 */
export function backfilledAt(recorded: DocItem[string]): string {
  return typeof recorded === 'string' ? recorded : BACKFILLED_AT;
}

/** The two attributes a row carries to appear in GSI1. */
export interface IndexKeys {
  gsi1pk: string;
  gsi1sk: string;
}

/** Default number of index partitions per adapter. */
export const DEFAULT_INDEX_SHARDS = 8;

/**
 * The most shards a recency index may have. The indexed read builds every
 * shard's partition key and issues at least one query per shard, so an
 * unbounded value turns a config typo into an unbounded stream of requests and
 * an out-of-memory crash. How many of those queries run at once is
 * `readConcurrency`.
 */
export const MAX_INDEX_SHARDS = 1024;

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
 * Throws: `VALIDATION` naming `indexShards` for a count below 1 — the read
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
 * Throws: `VALIDATION` naming `indexShards`.
 */
export function indexPartitions(tag: IndexTag, shards: number): string[] {
  assertShardCount(shards);
  return Array.from({ length: shards }, (_unused, shard) => `${tag}#${shard}`);
}

/** What a recency listing needs to read one page. */
export interface IndexQueryOptions {
  client: DynamoDBDocumentLike;
  tableName: string;
  indexName: string;
  tag: IndexTag;
  shards: number;
  /** Shards queried at once: the adapter's `readConcurrency`. */
  concurrency: number;
  /** Rows per page, checked by the caller's parser, so the query does not check it again. */
  limit: PageLimit;
  /** Opaque, from a previous page. */
  cursor?: string;
  retry?: RetryOptions;
  signal?: AbortSignal;
}

/** Where one shard stands while a listing builds a page. */
export interface ShardReader {
  partition: string;
  /**
   * The rows of the shard's last DynamoDB page that are not on the listing's
   * page yet, oldest first, so the newest is the last element and leaves with
   * `pop()`. Never more than one page.
   */
  buffer: DocItem[];
  /** Where the shard's next page starts; absent before its first page. */
  startKey: DocItem | undefined;
  /** True once DynamoDB reported no data past the last page read. */
  exhausted: boolean;
  /** DynamoDB pages read from this shard so far. */
  pages: number;
}

/**
 * A reader placed before a shard's first page.
 *
 * Accepts: `partition` — the shard's index partition key.
 *
 * Returns: a reader with an empty buffer that is not exhausted, so a listing
 * reads its first page before choosing any row.
 *
 * Throws: nothing.
 */
export function shardReader(partition: string): ShardReader {
  return { partition, buffer: [], startKey: undefined, exhausted: false, pages: 0 };
}

/** The `Query` for one page of one shard. */
function shardQuery(
  options: IndexQueryOptions,
  reader: ShardReader,
  before: string | undefined,
  limit: number,
): QueryCommandInput {
  return {
    TableName: options.tableName,
    IndexName: options.indexName,
    KeyConditionExpression: before === undefined ? '#pk = :pk' : '#pk = :pk AND #sk < :before',
    ExpressionAttributeNames: {
      '#pk': 'gsi1pk',
      ...(before === undefined ? {} : { '#sk': 'gsi1sk' }),
    },
    ExpressionAttributeValues: {
      ':pk': reader.partition,
      ...(before === undefined ? {} : { ':before': before }),
    },
    ScanIndexForward: false,
    Limit: limit,
    ...(reader.startKey === undefined ? {} : { ExclusiveStartKey: reader.startKey }),
  };
}

/**
 * Read a shard's next DynamoDB page into its buffer.
 *
 * `Limit` bounds the items a `Query` *evaluates*, and a page also stops at
 * 1 MB, so a shard of large rows answers with fewer than `limit` items and a
 * `LastEvaluatedKey`. Taking that short page as the whole shard is what made a
 * listing drop rows and report itself complete (C-01). The key is kept here
 * instead, and the listing reads the next page once the shard's buffer is empty
 * and its page still needs a row. One page at a time is what bounds a listing's
 * memory to at most one DynamoDB page per shard, besides the page it is
 * building.
 *
 * Accepts: `reader` — its buffer empty and the shard not exhausted. `before` —
 * the sort key to read below, or none for the newest. `limit` — the rows the
 * listing's page still needs, at least 1; the shard cannot contribute more.
 *
 * Returns: nothing. The reader's buffer holds the page's rows, and its key,
 * `exhausted` and page count describe what is left.
 *
 * Throws: `RESULT_TRUNCATED` naming `maxIterations`, without issuing
 * a query, when the shard has already read {@link MAX_LOOP_ITERATIONS} pages —
 * a listing fails rather than hand back a partial shard; whatever the query
 * throws, including an `ABORTED` error.
 */
export async function readShardPage(
  options: IndexQueryOptions,
  reader: ShardReader,
  before: string | undefined,
  limit: number,
): Promise<void> {
  if (reader.pages >= MAX_LOOP_ITERATIONS) {
    throw resultTruncatedError('maxIterations', MAX_LOOP_ITERATIONS);
  }
  const result = await withDynamoDBRetry(
    (request) => options.client.query(shardQuery(options, reader, before, limit), request),
    { ...options.retry, signal: options.signal },
  );
  reader.pages += 1;
  reader.buffer = ((result.Items ?? []) as DocItem[]).slice().reverse();
  reader.startKey = result.LastEvaluatedKey as DocItem | undefined;
  reader.exhausted = reader.startKey === undefined;
}
