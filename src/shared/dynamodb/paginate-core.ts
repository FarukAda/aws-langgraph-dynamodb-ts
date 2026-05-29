import { MAX_LOOP_ITERATIONS, MAX_TOTAL_ITEMS_IN_MEMORY } from '../constants';
import { AbortError } from '../errors/errors';
import type { DocItem } from './types';

/** One page of results plus the key to resume from (undefined when exhausted). */
export interface PageResult {
  items: DocItem[];
  lastKey: DocItem | undefined;
}

/** Options shared by the paginators built on {@link paginatePages}. */
export interface PaginateCoreOptions {
  signal?: AbortSignal;
  maxItems?: number;
  maxIterations?: number;
}

/**
 * Drive a paged DynamoDB read to completion, yielding each item. Continues past
 * empty pages, honors the abort signal before each fetch, and enforces
 * iteration + in-memory item caps. `fetchPage` performs one page read.
 */
export async function* paginatePages(
  fetchPage: (startKey: DocItem | undefined) => Promise<PageResult>,
  options: PaginateCoreOptions = {},
): AsyncGenerator<DocItem> {
  const maxItems = options.maxItems ?? MAX_TOTAL_ITEMS_IN_MEMORY;
  const maxIterations = options.maxIterations ?? MAX_LOOP_ITERATIONS;
  let startKey: DocItem | undefined;
  let yielded = 0;
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (options.signal?.aborted) throw new AbortError();
    const page = await fetchPage(startKey);
    for (const item of page.items) {
      yield item;
      yielded += 1;
      if (yielded >= maxItems) return;
    }
    startKey = page.lastKey;
    if (startKey === undefined) return;
  }
}
