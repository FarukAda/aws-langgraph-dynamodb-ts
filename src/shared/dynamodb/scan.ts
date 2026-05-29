import type { DynamoDBDocument, ScanCommandInput } from '@aws-sdk/lib-dynamodb';

import { type PaginateCoreOptions, paginatePages } from './paginate-core';
import { withDynamoDBRetry } from './retry';
import type { DocItem } from './types';

/** Options for {@link paginateScan}. */
export interface ScanOptions extends PaginateCoreOptions {
  client: DynamoDBDocument;
  params: ScanCommandInput;
}

/**
 * Drive a DynamoDB Scan across all pages, yielding each item. Shares the
 * pagination core with {@link paginateQuery}: abort handling, retry per page,
 * and runaway guards.
 */
export function paginateScan(options: ScanOptions): AsyncGenerator<DocItem> {
  return paginatePages(async (startKey) => {
    const page = await withDynamoDBRetry(
      () => options.client.scan({ ...options.params, ExclusiveStartKey: startKey }),
      { signal: options.signal },
    );
    return {
      items: (page.Items as DocItem[] | undefined) ?? [],
      lastKey: page.LastEvaluatedKey as DocItem | undefined,
    };
  }, options);
}
