import type { QueryCommandInput } from '@aws-sdk/lib-dynamodb';

import type { DynamoDBDocumentLike } from './client-types';
import { type PaginateCoreOptions, paginatePages } from './paginate-core';
import { withDynamoDBRetry } from './retry';
import type { DocItem } from './types';

/** Options for {@link paginateQuery}. */
export interface PaginateOptions extends PaginateCoreOptions {
  client: DynamoDBDocumentLike;
  params: QueryCommandInput;
}

/**
 * Every item a Query returns, across all its pages.
 *
 * Accepts: `params` — the Query input; `ExclusiveStartKey` is set per page and
 * anything the caller put there is replaced. `retry` and `signal` are applied
 * to each page read, `maxItems` / `maxIterations` to the walk (see
 * {@link paginatePages}).
 *
 * Returns: an async generator over the items, following `LastEvaluatedKey`
 * until it is absent. A page carrying no `Items` is an empty page, not the end.
 *
 * Throws: whatever the page read throws, plus the caps and abort behaviour of
 * {@link paginatePages}.
 */
export function paginateQuery(options: PaginateOptions): AsyncGenerator<DocItem> {
  return paginatePages(async (startKey) => {
    const page = await withDynamoDBRetry(
      (request) =>
        options.client.query({ ...options.params, ExclusiveStartKey: startKey }, request),
      { ...options.retry, signal: options.signal },
    );
    return {
      items: (page.Items as DocItem[] | undefined) ?? [],
      lastKey: page.LastEvaluatedKey as DocItem | undefined,
    };
  }, options);
}
