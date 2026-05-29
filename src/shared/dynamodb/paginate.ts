import type { DynamoDBDocument, QueryCommandInput } from '@aws-sdk/lib-dynamodb';

import { MAX_LOOP_ITERATIONS, MAX_TOTAL_ITEMS_IN_MEMORY } from '../constants';
import { AbortError } from '../errors/errors';
import { withDynamoDBRetry } from './retry';
import type { DocItem } from './types';

/** Options for {@link paginateQuery}. */
export interface PaginateOptions {
  client: DynamoDBDocument;
  params: QueryCommandInput;
  signal?: AbortSignal;
  maxItems?: number;
  maxIterations?: number;
}

/**
 * Drive a DynamoDB Query across all pages, yielding each item. Follows
 * `LastEvaluatedKey` (continuing past empty pages), honors the abort signal
 * before every page, wraps each page in {@link withDynamoDBRetry}, and enforces
 * iteration + in-memory item caps as runaway guards.
 */
export async function* paginateQuery(options: PaginateOptions): AsyncGenerator<DocItem> {
  const maxItems = options.maxItems ?? MAX_TOTAL_ITEMS_IN_MEMORY;
  const maxIterations = options.maxIterations ?? MAX_LOOP_ITERATIONS;
  let startKey: DocItem | undefined;
  let yielded = 0;
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (options.signal?.aborted) throw new AbortError();
    const page = await withDynamoDBRetry(
      () => options.client.query({ ...options.params, ExclusiveStartKey: startKey }),
      { signal: options.signal },
    );
    for (const item of (page.Items as DocItem[] | undefined) ?? []) {
      yield item;
      yielded += 1;
      if (yielded >= maxItems) return;
    }
    startKey = page.LastEvaluatedKey as DocItem | undefined;
    if (startKey === undefined) return;
  }
}
