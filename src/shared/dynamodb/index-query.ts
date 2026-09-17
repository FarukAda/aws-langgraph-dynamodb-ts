import { mapWithConcurrency } from '../concurrency';
import { ValidationError } from '../errors/errors';
import { validateInteger } from '../validation/primitives';
import { indexPartitions } from './index-keys';
import { type IndexQueryOptions, queryShard } from './index-shard';
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
 * Throws: ValidationError naming `cursor` for anything that does not decode to
 * a sort key of this index. `gsi1sk` is `<timestamp>#<id>`, so a value carrying
 * no `#` was issued by something else — a scan cursor, a page token from
 * another API — and using it as a bound would quietly return the wrong page
 * rather than say so.
 */
function decodeCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!decoded.includes('#')) {
    throw new ValidationError('cursor is not one this adapter issued', 'cursor');
  }
  return decoded;
}

/**
 * Read one page of a recency listing from the index, newest first.
 *
 * Every shard is read for its own newest `limit` rows and the results are
 * merged. Taking `limit` from the merge is correct because each shard is
 * already sorted and supplied either `limit` rows or every row it had, so no
 * shard holds a row newer than the page's last that it did not return. The
 * alternative — one query over an unsharded index — would make every listing
 * hit one partition, which is what the sharding exists to avoid.
 *
 * This replaces a full-table `Scan` with a `FilterExpression`, which consumed
 * read capacity for every row *evaluated*, collected the whole table in memory
 * and sorted it there.
 *
 * Accepts: `limit` — a positive integer; rows per page. `cursor` — from a
 * previous page, or none to start at the newest. `shards` — must match what the
 * writers used. `concurrency` — how many shards are read at once.
 *
 * Returns: the page, newest first, and a `nextCursor` exactly while rows may
 * remain: the merge held more than `limit` rows, or some shard did not report
 * its end. A cursor is never withheld while rows remain, and none is issued
 * once every shard has reported its end, even for a page filled exactly.
 * DynamoDB can still report a `LastEvaluatedKey` for a shard whose `limit`th
 * row was its last, so the page after such a cursor may come back empty.
 *
 * Throws: ValidationError naming `limit` or `cursor`; `ResultTruncatedError`
 * for a shard whose pages do not end within `MAX_LOOP_ITERATIONS`; whatever
 * the queries throw, including `AbortError`.
 *
 * Guarantees: at most `concurrency` shard reads at once, and each shard is
 * followed across DynamoDB's 1 MB page boundary until it has supplied `limit`
 * rows or run out, so no shard contributes more than `limit` rows to a page.
 */
export async function queryRecencyIndex(options: IndexQueryOptions): Promise<IndexPage> {
  validateInteger(options.limit, 'limit', { min: 1 });
  const before = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
  const partitions = indexPartitions(options.tag, options.shards);
  const shards = await mapWithConcurrency(partitions, options.concurrency, (partition) =>
    queryShard(options, partition, before),
  );
  const merged = shards
    .flatMap((shard) => shard.items)
    .sort((a, b) => ((a.gsi1sk as string) < (b.gsi1sk as string) ? 1 : -1));
  const page = merged.slice(0, options.limit);
  /**
   * Rows remain when the merge overflowed the page or a shard still holds
   * some. Every shard supplied either `limit` rows or all it had, so either
   * way the page is non-empty and its last row is the right place to resume.
   */
  const remain = merged.length > options.limit || shards.some((shard) => !shard.exhausted);
  return {
    items: page,
    ...(remain ? { nextCursor: encodeCursor(page[page.length - 1].gsi1sk as string) } : {}),
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
