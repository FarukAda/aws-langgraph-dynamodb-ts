import type { DynamoDBDocument, QueryCommandInput } from '@aws-sdk/lib-dynamodb';

import { type PaginateCoreOptions, paginatePages } from './paginate-core';
import { withDynamoDBRetry } from './retry';
import type { DocItem } from './types';

/** Options for {@link paginateQuery}. */
export interface PaginateOptions extends PaginateCoreOptions {
  client: DynamoDBDocument;
  params: QueryCommandInput;
}

/**
 * Drive a DynamoDB Query across all pages, yielding each item. Follows
 * `LastEvaluatedKey`, honors the abort signal, wraps each page in
 * {@link withDynamoDBRetry}, and enforces runaway guards via the shared core.
 */
export function paginateQuery(options: PaginateOptions): AsyncGenerator<DocItem> {
  return paginatePages(async (startKey) => {
    const page = await withDynamoDBRetry(
      () => options.client.query({ ...options.params, ExclusiveStartKey: startKey }),
      { ...options.retry, signal: options.signal },
    );
    return {
      items: (page.Items as DocItem[] | undefined) ?? [],
      lastKey: page.LastEvaluatedKey as DocItem | undefined,
    };
  }, options);
}
