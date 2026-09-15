import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import { mapWithConcurrency } from '../concurrency';
import { ValidationError } from '../errors/errors';
import { type IndexTag, indexPartitions } from './index-keys';
import { withDynamoDBRetry } from './retry';
import type { RetryOptions } from './retry';
import type { DocItem } from './types';

/** One page of a recency listing, and where the next one resumes. */
export interface IndexPage {
  items: DocItem[];
  /** Absent when the page is the last one. */
  nextCursor?: string;
}

/** What a recency listing needs to read one page. */
export interface IndexQueryOptions {
  client: DynamoDBDocument;
  tableName: string;
  indexName: string;
  tag: IndexTag;
  shards: number;
  /** Rows per page. */
  limit: number;
  /** Opaque, from a previous page. */
  cursor?: string;
  retry?: RetryOptions;
  signal?: AbortSignal;
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

/** One shard's newest rows below the cursor. */
async function queryShard(
  options: IndexQueryOptions,
  partition: string,
  before: string | undefined,
): Promise<DocItem[]> {
  const result = await withDynamoDBRetry(
    () =>
      options.client.query({
        TableName: options.tableName,
        IndexName: options.indexName,
        KeyConditionExpression: before === undefined ? '#pk = :pk' : '#pk = :pk AND #sk < :before',
        ExpressionAttributeNames: {
          '#pk': 'gsi1pk',
          ...(before === undefined ? {} : { '#sk': 'gsi1sk' }),
        },
        ExpressionAttributeValues: {
          ':pk': partition,
          ...(before === undefined ? {} : { ':before': before }),
        },
        ScanIndexForward: false,
        Limit: options.limit,
      }),
    { ...options.retry, signal: options.signal },
  );
  return (result.Items ?? []) as DocItem[];
}

/**
 * Read one page of a recency listing from the index, newest first.
 *
 * Every shard is queried for its own newest `limit` rows and the results are
 * merged; taking `limit` from the merge is correct because each shard is
 * already sorted and no shard can contribute a row newer than the ones it
 * returned. The alternative — one query over an unsharded index — would make
 * every listing hit one partition, which is what the sharding exists to avoid.
 *
 * This replaces a full-table `Scan` with a `FilterExpression`, which consumed
 * read capacity for every row *evaluated*, collected the whole table in memory
 * and sorted it there.
 *
 * Accepts: `limit` — a positive integer; rows per page. `cursor` — from a
 * previous page, or none to start at the newest. `shards` — must match what the
 * writers used.
 *
 * Returns: the page, newest first, and a `nextCursor` only when the page filled
 * up: a short page means every shard was exhausted, so handing one back would
 * cost an empty round of queries to discover that.
 *
 * Throws: ValidationError naming `limit` or `cursor`; whatever the queries
 * throw.
 *
 * Guarantees: one bounded query per shard, issued concurrently, whatever the
 * table holds. Taking `limit` from the merge is correct because each shard is
 * already sorted and no shard can contribute a row newer than the ones it
 * returned.
 */
export async function queryRecencyIndex(options: IndexQueryOptions): Promise<IndexPage> {
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new ValidationError('limit must be a positive integer', 'limit');
  }
  const before = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
  const partitions = indexPartitions(options.tag, options.shards);
  const perShard = await mapWithConcurrency(partitions, partitions.length, (partition) =>
    queryShard(options, partition, before),
  );
  const merged = perShard
    .flat()
    .sort((a, b) => ((a.gsi1sk as string) < (b.gsi1sk as string) ? 1 : -1));
  const page = merged.slice(0, options.limit);
  /**
   * More rows remain only when this page filled up; a short page means every
   * shard was exhausted, so handing back a cursor would cost an empty round of
   * queries to discover that.
   */
  const last = page.length === options.limit ? page[page.length - 1] : undefined;
  return {
    items: page,
    ...(last === undefined ? {} : { nextCursor: encodeCursor(last.gsi1sk as string) }),
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
