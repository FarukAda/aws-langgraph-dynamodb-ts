import { MAX_LOOP_ITERATIONS, MAX_TOTAL_ITEMS_IN_MEMORY } from '../constants';
import { ResultTruncatedError, ValidationError } from '../errors/errors';
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

/** Reject a cap that admits nothing; `Infinity` is the way to ask for no cap. */
function assertPositiveCap(value: number, field: string): number {
  if (!(value >= 1)) {
    throw new ValidationError(
      `${field} must be at least 1 (pass Infinity to read to completion)`,
      field,
    );
  }
  return value;
}

/**
 * Drive a paged DynamoDB read to completion, yielding each item.
 *
 * Accepts: `fetchPage` — performs one page read from a start key.
 * `options.maxItems` — how many items may be yielded, default
 * {@link MAX_TOTAL_ITEMS_IN_MEMORY}. `options.maxIterations` — how many page
 * reads may be issued, default {@link MAX_LOOP_ITERATIONS}; the probe below is
 * charged against it too. Both accept `Infinity` to read to true completion
 * (deletes do), and both must otherwise be at least 1 — a cap of 0 used to
 * yield one item before noticing. `options.signal` — checked before every
 * fetch. `options.retry` is the page reader's own concern.
 *
 * Returns: an async generator over the items, continuing past empty pages.
 *
 * Throws: ValidationError naming `maxItems` or `maxIterations` for a cap below
 * 1; `AbortError` when the signal is already aborted at a page boundary; and
 * {@link ResultTruncatedError} when a cap is reached while data actually
 * remains — a partial result is never returned silently.
 *
 * Guarantees: reaching `maxItems` on the last item of a page is not by itself a
 * truncation. DynamoDB returns a `LastEvaluatedKey` whenever it stopped
 * *evaluating* at the 1 MB boundary, whether or not a later item passes the
 * filter, so the remaining keys are followed until one carries an item
 * (truncated) or they run out (the result was complete).
 */
export async function* paginatePages(
  fetchPage: (startKey: DocItem | undefined) => Promise<PageResult>,
  options: PaginateCoreOptions = {},
): AsyncGenerator<DocItem> {
  const maxItems = assertPositiveCap(options.maxItems ?? MAX_TOTAL_ITEMS_IN_MEMORY, 'maxItems');
  const reader: Reader = {
    fetchPage,
    maxIterations: assertPositiveCap(options.maxIterations ?? MAX_LOOP_ITERATIONS, 'maxIterations'),
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
