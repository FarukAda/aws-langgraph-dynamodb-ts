import { mapWithConcurrency } from '../concurrency';
import { ValidationError } from '../errors/errors';
import { validateInteger } from '../validation/primitives';
import { indexPartitions } from './index-keys';
import {
  type IndexQueryOptions,
  readShardPage,
  type ShardReader,
  shardReader,
} from './index-shard';
import type { DocItem } from './types';

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
 * Throws: ValidationError naming `cursor` when the decoded value carries no
 * `#`. `gsi1sk` is `<timestamp>#<id>`, so such a value was issued by something
 * else — a scan cursor, a page token from another API — and using it as a bound
 * would quietly return the wrong page rather than say so. A value that carries
 * a `#` is not checked further.
 */
function decodeCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!decoded.includes('#')) {
    throw new ValidationError('cursor is not one this adapter issued', 'cursor');
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

/** Move the newest buffered row off its shard; undefined when every buffer is empty. */
function takeNewest(readers: ShardReader[]): DocItem | undefined {
  let newest: ShardReader | undefined;
  let newestKey = '';
  for (const reader of readers) {
    const head = reader.buffer[reader.buffer.length - 1];
    if (head !== undefined && (head.gsi1sk as string) > newestKey) {
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
 * Accepts: `limit` — a positive integer; rows per page. `cursor` — from a
 * previous page, or none to start at the newest. `shards` — must match what the
 * writers used. `concurrency` — how many shards are queried at once.
 *
 * Returns: the page, newest first, and a `nextCursor` exactly while rows may
 * remain: a shard still buffers a row the page did not take, or has not
 * reported its end. A cursor is never withheld while rows remain, and none is
 * issued once every shard has reported its end, even for a page filled
 * exactly. DynamoDB can still report a `LastEvaluatedKey` on a page that ends
 * at a shard's last row, so the page after such a cursor may come back empty.
 *
 * Throws: ValidationError naming `limit` or `cursor`; `ResultTruncatedError`
 * for a shard whose pages do not end within `MAX_LOOP_ITERATIONS`; whatever
 * the queries throw, including `AbortError`.
 *
 * Guarantees: at most `concurrency` shards are queried at once; each shard is
 * followed across DynamoDB's 1 MB page boundary, but its next page is read only
 * when its buffer is empty and the page still needs a row, so besides the page
 * being built, up to `limit` rows, no more than one DynamoDB page per shard is
 * held at a time.
 */
export async function queryRecencyIndex(options: IndexQueryOptions): Promise<IndexPage> {
  validateInteger(options.limit, 'limit', { min: 1 });
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
const STREAM_PAGE_SIZE = 100;

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
