import { MAX_LOOP_ITERATIONS, MAX_TOTAL_ITEMS_IN_MEMORY } from '../constants';
import { AbortError, ResultTruncatedError } from '../errors/errors';
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

/** True when stopping at `index` of `page` would leave unyielded data behind. */
function moreDataRemains(page: PageResult, index: number): boolean {
  return index < page.items.length - 1 || page.lastKey !== undefined;
}

/**
 * Yield one page's items, counting toward the shared `state.yielded` budget.
 * Returns `true` when the in-memory cap is reached (caller stops); throws
 * {@link ResultTruncatedError} if stopping would leave unyielded data behind.
 */
async function* yieldPageItems(
  page: PageResult,
  state: { yielded: number },
  maxItems: number,
): AsyncGenerator<DocItem, boolean> {
  for (let index = 0; index < page.items.length; index++) {
    yield page.items[index];
    state.yielded += 1;
    if (state.yielded >= maxItems) {
      if (moreDataRemains(page, index)) throw new ResultTruncatedError('maxItems', maxItems);
      return true;
    }
  }
  return false;
}

/**
 * Drive a paged DynamoDB read to completion, yielding each item. Continues past
 * empty pages, honors the abort signal before each fetch, and enforces iteration
 * + in-memory item caps. `fetchPage` performs one page read. When a cap is hit
 * while more data remains, throws {@link ResultTruncatedError} rather than
 * silently returning a partial result; pass `Infinity` caps to read to true
 * completion (e.g. for deletes).
 */
export async function* paginatePages(
  fetchPage: (startKey: DocItem | undefined) => Promise<PageResult>,
  options: PaginateCoreOptions = {},
): AsyncGenerator<DocItem> {
  const maxItems = options.maxItems ?? MAX_TOTAL_ITEMS_IN_MEMORY;
  const maxIterations = options.maxIterations ?? MAX_LOOP_ITERATIONS;
  const state = { yielded: 0 };
  let startKey: DocItem | undefined;
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (options.signal?.aborted) throw new AbortError();
    const page = await fetchPage(startKey);
    if (yield* yieldPageItems(page, state, maxItems)) return;
    startKey = page.lastKey;
    if (startKey === undefined) return;
  }
  throw new ResultTruncatedError('maxIterations', maxIterations);
}
