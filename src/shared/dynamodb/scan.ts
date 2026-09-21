import type { ScanCommandInput } from '@aws-sdk/lib-dynamodb';

import type { DynamoDBDocumentLike } from './client-types';
import { type PaginateCoreOptions, paginatePages } from './paginate-core';
import { withDynamoDBRetry } from './retry';
import type { DocItem } from './types';

/** Options for {@link paginateScan}. */
export interface ScanOptions extends PaginateCoreOptions {
  client: DynamoDBDocumentLike;
  params: ScanCommandInput;
}

/**
 * Every item a Scan returns, across all its pages.
 *
 * Accepts: as {@link paginateQuery}; only the request differs.
 *
 * Returns: as {@link paginateQuery} — an async generator over the items, which
 * a consumer may abandon early to stop reading.
 *
 * Throws: as {@link paginateQuery}.
 *
 * A `Scan` reads every row of the table before filtering, so the four reads
 * allowed to call this are fixed and guarded; `test/static/guards/scan-sites.ts`
 * lists them and states the rule they follow.
 */
export function paginateScan(options: ScanOptions): AsyncGenerator<DocItem> {
  return paginatePages(async (startKey) => {
    const page = await withDynamoDBRetry(
      (request) => options.client.scan({ ...options.params, ExclusiveStartKey: startKey }, request),
      { ...options.retry, signal: options.signal },
    );
    return {
      items: (page.Items as DocItem[] | undefined) ?? [],
      lastKey: page.LastEvaluatedKey as DocItem | undefined,
    };
  }, options);
}
