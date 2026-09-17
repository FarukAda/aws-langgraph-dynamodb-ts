import type { DynamoDBDocument, QueryCommandInput } from '@aws-sdk/lib-dynamodb';

import { MAX_LOOP_ITERATIONS } from '../constants';
import { ResultTruncatedError } from '../errors/errors';
import type { IndexTag } from './index-keys';
import { withDynamoDBRetry } from './retry';
import type { RetryOptions } from './retry';
import type { DocItem } from './types';

/** What a recency listing needs to read one page. */
export interface IndexQueryOptions {
  client: DynamoDBDocument;
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

/** One shard's contribution to a page. */
export interface ShardRows {
  /** The shard's newest rows below the bound, newest first; never more than `limit`. */
  items: DocItem[];
  /** True when DynamoDB reported no data past `items`. */
  exhausted: boolean;
}

/** The `Query` for one page of one shard. */
function shardQuery(
  options: IndexQueryOptions,
  partition: string,
  before: string | undefined,
  limit: number,
  startKey: DocItem | undefined,
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
      ':pk': partition,
      ...(before === undefined ? {} : { ':before': before }),
    },
    ScanIndexForward: false,
    Limit: limit,
    ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
  };
}

/**
 * One shard's newest `limit` rows below `before`, however many pages DynamoDB
 * splits them across.
 *
 * `Limit` bounds the items a `Query` *evaluates*, and a page also stops at
 * 1 MB, so a shard of large rows answers with fewer than `limit` items and a
 * `LastEvaluatedKey`. Taking that short page as the whole shard is what made a
 * listing drop rows and report itself complete (C-01), so the key is followed
 * until the shard has supplied `limit` rows or has none left. The merge in
 * `queryRecencyIndex` depends on exactly that: a shard that stopped anywhere
 * else could hold rows newer than ones another shard put on the page.
 *
 * Accepts: `before` — the sort key to read below, or none for the newest.
 *
 * Returns: the rows and whether the shard is exhausted.
 *
 * Throws: {@link ResultTruncatedError} after {@link MAX_LOOP_ITERATIONS} pages
 * without either outcome, rather than hand back a partial shard; whatever the
 * query throws, including `AbortError` between pages.
 */
export async function queryShard(
  options: IndexQueryOptions,
  partition: string,
  before: string | undefined,
): Promise<ShardRows> {
  const items: DocItem[] = [];
  let startKey: DocItem | undefined;
  for (let page = 0; page < MAX_LOOP_ITERATIONS; page++) {
    const result = await withDynamoDBRetry(
      () =>
        options.client.query(
          shardQuery(options, partition, before, options.limit - items.length, startKey),
        ),
      { ...options.retry, signal: options.signal },
    );
    items.push(...((result.Items ?? []) as DocItem[]));
    startKey = result.LastEvaluatedKey as DocItem | undefined;
    if (startKey === undefined) return { items, exhausted: true };
    if (items.length >= options.limit) return { items, exhausted: false };
  }
  throw new ResultTruncatedError('maxIterations', MAX_LOOP_ITERATIONS);
}
