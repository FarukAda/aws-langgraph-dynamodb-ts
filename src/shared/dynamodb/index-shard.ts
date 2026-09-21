import type { QueryCommandInput } from '@aws-sdk/lib-dynamodb';

import { MAX_LOOP_ITERATIONS } from '../constants';
import { ResultTruncatedError } from '../errors/errors';
import type { DynamoDBDocumentLike } from './client-types';
import type { IndexTag } from './index-keys';
import { withDynamoDBRetry } from './retry';
import type { RetryOptions } from './retry';
import type { DocItem } from './types';

/** What a recency listing needs to read one page. */
export interface IndexQueryOptions {
  client: DynamoDBDocumentLike;
  tableName: string;
  indexName: string;
  tag: IndexTag;
  shards: number;
  /** Shards queried at once: the adapter's `readConcurrency`. */
  concurrency: number;
  /** Rows per page. */
  limit: number;
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
 * Throws: {@link ResultTruncatedError} naming `maxIterations`, without issuing
 * a query, when the shard has already read {@link MAX_LOOP_ITERATIONS} pages —
 * a listing fails rather than hand back a partial shard; whatever the query
 * throws, including `AbortError`.
 */
export async function readShardPage(
  options: IndexQueryOptions,
  reader: ShardReader,
  before: string | undefined,
  limit: number,
): Promise<void> {
  if (reader.pages >= MAX_LOOP_ITERATIONS) {
    throw new ResultTruncatedError('maxIterations', MAX_LOOP_ITERATIONS);
  }
  const result = await withDynamoDBRetry(
    () => options.client.query(shardQuery(options, reader, before, limit)),
    { ...options.retry, signal: options.signal },
  );
  reader.pages += 1;
  reader.buffer = ((result.Items ?? []) as DocItem[]).slice().reverse();
  reader.startKey = result.LastEvaluatedKey as DocItem | undefined;
  reader.exhausted = reader.startKey === undefined;
}
