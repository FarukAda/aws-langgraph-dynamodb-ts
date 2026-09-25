/**
 * Hides that a Query or a Scan is many pages.
 *
 * A read receives items one at a time and never sees a page boundary. How many
 * items and pages it may collect before it refuses with `RESULT_TRUNCATED`
 * rather than truncating silently, how a read that stopped exactly at its item
 * cap probes whether anything remained, and where cancellation is checked
 * between pages are decided here, the same way for a Query and a Scan.
 */

import type { QueryCommandInput, ScanCommandInput } from '@aws-sdk/lib-dynamodb';

import { resultTruncatedError, validationError } from '../errors/errors';
import { abortErrorFrom } from './abort';
import type { DynamoDBDocumentLike, AttributeMap } from './client';
import { type RetryOptions, withDynamoDBRetry } from './retry';

/** Hard cap on query-pagination loop iterations (runaway-loop guard). */
export const MAX_LOOP_ITERATIONS = 1000;

/** Hard cap on items collected into memory across a paginated query. */
export const MAX_TOTAL_ROWS_IN_MEMORY = 10000;

/**
 * Raw rows a single `listCheckpoints` call may pull before it warns. The read
 * itself is deliberately unbounded — capping it counted raw rows rather than
 * filter-matched ones, which turned a caller asking for a handful of rare
 * matches over a large thread into a hard error instead of the true answer.
 * The warning restores the operational signal without restoring the wrong
 * error.
 *
 * Its own literal, deliberately: this is the point at which a scan is worth
 * telling an operator about, which is independent of
 * {@link MAX_TOTAL_ROWS_IN_MEMORY}'s hard collection cap. Aliasing the two
 * meant retuning the memory cap silently moved the warning as well, and it
 * left the pair reported as a duplicate export.
 */
export const LIST_SCAN_WARN_THRESHOLD = 10000;

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
export function paginateQuery(options: PaginateOptions): AsyncGenerator<AttributeMap> {
  return paginatePages(async (startKey) => {
    const page = await withDynamoDBRetry(
      (request) =>
        options.client.query({ ...options.params, ExclusiveStartKey: startKey }, request),
      { ...options.retry, signal: options.signal },
    );
    return {
      items: (page.Items as AttributeMap[] | undefined) ?? [],
      lastKey: page.LastEvaluatedKey as AttributeMap | undefined,
    };
  }, options);
}

/** One page of results plus the key to resume from (undefined when exhausted). */
export interface PageResult {
  items: AttributeMap[];
  lastKey: AttributeMap | undefined;
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
  fetchPage: (startKey: AttributeMap | undefined) => Promise<PageResult>;
  maxIterations: number;
  iterations: number;
  signal?: AbortSignal;
}

/** Read the next page, honouring the abort signal and the iteration cap first. */
async function readPage(reader: Reader, startKey: AttributeMap | undefined): Promise<PageResult> {
  if (reader.iterations >= reader.maxIterations) {
    throw resultTruncatedError('maxIterations', reader.maxIterations);
  }
  if (reader.signal?.aborted) throw abortErrorFrom(reader.signal);
  reader.iterations += 1;
  return reader.fetchPage(startKey);
}

/** Why {@link yieldPageRows} stopped: the page ran out, or the item cap was reached. */
type PageOutcome = 'exhausted' | 'capped';

/**
 * Yield one page's items, counting toward the shared `state.yielded` budget.
 * Reaching the cap with unyielded items still on the page is a truncation;
 * reaching it on the last item is reported as `capped` for the caller to settle.
 *
 * Synchronous and private: nothing here awaits, and `paginatePages` delegates
 * to it with `yield*` from inside its own `async function*`, so the items it
 * yields still reach callers through the same async-generator protocol.
 */
function* yieldPageRows(
  page: PageResult,
  state: { yielded: number },
  maxItems: number,
): Generator<AttributeMap, PageOutcome> {
  for (let index = 0; index < page.items.length; index++) {
    yield page.items[index];
    state.yielded += 1;
    if (state.yielded >= maxItems) {
      if (index < page.items.length - 1) throw resultTruncatedError('maxItems', maxItems);
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
async function dataRemains(reader: Reader, startKey: AttributeMap | undefined): Promise<boolean> {
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
    throw validationError(
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
 * {@link MAX_TOTAL_ROWS_IN_MEMORY}. `options.maxIterations` — how many page
 * reads may be issued, default {@link MAX_LOOP_ITERATIONS}; the probe below is
 * charged against it too. Both accept `Infinity` to read to true completion
 * (deletes do), and both must otherwise be at least 1 — an accepted cap of 0
 * would yield one item before noticing. `options.signal` — checked before every
 * fetch. `options.retry` is the page reader's own concern.
 *
 * Returns: an async generator over the items, continuing past empty pages.
 *
 * Throws: `VALIDATION` naming `maxItems` or `maxIterations` for a cap below
 * 1; `ABORTED` when the signal is already aborted at a page boundary; and
 * `RESULT_TRUNCATED` when a cap is reached while data actually
 * remains — a partial result is never returned silently.
 *
 * Guarantees: reaching `maxItems` on the last item of a page is not by itself a
 * truncation. DynamoDB returns a `LastEvaluatedKey` whenever it stopped
 * *evaluating* at the 1 MB boundary, whether or not a later item passes the
 * filter, so the remaining keys are followed until one carries an item
 * (truncated) or they run out (the result was complete).
 */
export async function* paginatePages(
  fetchPage: (startKey: AttributeMap | undefined) => Promise<PageResult>,
  options: PaginateCoreOptions = {},
): AsyncGenerator<AttributeMap> {
  const maxItems = assertPositiveCap(options.maxItems ?? MAX_TOTAL_ROWS_IN_MEMORY, 'maxItems');
  const reader: Reader = {
    fetchPage,
    maxIterations: assertPositiveCap(options.maxIterations ?? MAX_LOOP_ITERATIONS, 'maxIterations'),
    iterations: 0,
    signal: options.signal,
  };
  const state = { yielded: 0 };
  let startKey: AttributeMap | undefined;
  for (;;) {
    const page = await readPage(reader, startKey);
    const outcome = yield* yieldPageRows(page, state, maxItems);
    if (outcome === 'capped') {
      if (await dataRemains(reader, page.lastKey)) throw resultTruncatedError('maxItems', maxItems);
      return;
    }
    startKey = page.lastKey;
    if (startKey === undefined) return;
  }
}

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
export function paginateScan(options: ScanOptions): AsyncGenerator<AttributeMap> {
  return paginatePages(async (startKey) => {
    const page = await withDynamoDBRetry(
      (request) => options.client.scan({ ...options.params, ExclusiveStartKey: startKey }, request),
      { ...options.retry, signal: options.signal },
    );
    return {
      items: (page.Items as AttributeMap[] | undefined) ?? [],
      lastKey: page.LastEvaluatedKey as AttributeMap | undefined,
    };
  }, options);
}
