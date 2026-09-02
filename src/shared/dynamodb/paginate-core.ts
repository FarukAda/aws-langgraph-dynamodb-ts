import { MAX_LOOP_ITERATIONS, MAX_TOTAL_ITEMS_IN_MEMORY } from '../constants';
import { ResultTruncatedError } from '../errors/errors';
import { abortErrorFrom } from './abort';
import type { RetryOptions } from './retry';
import type { DocItem } from './types';

/** One page of results plus the key to resume from (undefined when exhausted). */
export interface PageResult {
  items: DocItem[];
  lastKey: DocItem | undefined;
}

/** Options shared by the paginators built on {@link paginatePages}. */
export interface PaginateCoreOptions {
  /** The adapter's retry options, applied to every page read. */
  retry?: RetryOptions;
  signal?: AbortSignal;
  maxItems?: number;
  maxIterations?: number;
}

/** A page reader plus the fetch budget every page, probe included, is charged against. */
interface Reader {
  fetchPage: (startKey: DocItem | undefined) => Promise<PageResult>;
  maxIterations: number;
  iterations: number;
  signal?: AbortSignal;
}

/** Read the next page, honouring the abort signal and the iteration cap first. */
async function readPage(reader: Reader, startKey: DocItem | undefined): Promise<PageResult> {
  if (reader.iterations >= reader.maxIterations) {
    throw new ResultTruncatedError('maxIterations', reader.maxIterations);
  }
  if (reader.signal?.aborted) throw abortErrorFrom(reader.signal);
  reader.iterations += 1;
  return reader.fetchPage(startKey);
}

/** Why {@link yieldPageItems} stopped: the page ran out, or the item cap was reached. */
type PageOutcome = 'exhausted' | 'capped';

/**
 * Yield one page's items, counting toward the shared `state.yielded` budget.
 * Reaching the cap with unyielded items still on the page is a truncation;
 * reaching it on the last item is reported as `capped` for the caller to settle.
 */
async function* yieldPageItems(
  page: PageResult,
  state: { yielded: number },
  maxItems: number,
): AsyncGenerator<DocItem, PageOutcome> {
  for (let index = 0; index < page.items.length; index++) {
    yield page.items[index];
    state.yielded += 1;
    if (state.yielded >= maxItems) {
      if (index < page.items.length - 1) throw new ResultTruncatedError('maxItems', maxItems);
      return 'capped';
    }
  }
  return 'exhausted';
}

/**
 * Whether anything remains past `startKey`. DynamoDB returns a
 * `LastEvaluatedKey` whenever it stopped *evaluating* at the 1 MB boundary,
 * whether or not a later item passes the filter, so a trailing key alone proves
 * nothing: the keys are followed until a page carries an item (truncated) or
 * they run out (the result was complete). The probe is charged against the same
 * iteration budget and honours the same signal as the read itself.
 */
async function dataRemains(reader: Reader, startKey: DocItem | undefined): Promise<boolean> {
  let key = startKey;
  while (key !== undefined) {
    const page = await readPage(reader, key);
    if (page.items.length > 0) return true;
    key = page.lastKey;
  }
  return false;
}

/**
 * Drive a paged DynamoDB read to completion, yielding each item. Continues past
 * empty pages, honors the abort signal before each fetch, and enforces iteration
 * + in-memory item caps. `fetchPage` performs one page read. When a cap is hit
 * while more data actually remains, throws {@link ResultTruncatedError} rather
 * than silently returning a partial result; pass `Infinity` caps to read to true
 * completion (e.g. for deletes).
 */
export async function* paginatePages(
  fetchPage: (startKey: DocItem | undefined) => Promise<PageResult>,
  options: PaginateCoreOptions = {},
): AsyncGenerator<DocItem> {
  const maxItems = options.maxItems ?? MAX_TOTAL_ITEMS_IN_MEMORY;
  const reader: Reader = {
    fetchPage,
    maxIterations: options.maxIterations ?? MAX_LOOP_ITERATIONS,
    iterations: 0,
    signal: options.signal,
  };
  const state = { yielded: 0 };
  let startKey: DocItem | undefined;
  for (;;) {
    const page = await readPage(reader, startKey);
    const outcome = yield* yieldPageItems(page, state, maxItems);
    if (outcome === 'capped') {
      if (await dataRemains(reader, page.lastKey))
        throw new ResultTruncatedError('maxItems', maxItems);
      return;
    }
    startKey = page.lastKey;
    if (startKey === undefined) return;
  }
}
