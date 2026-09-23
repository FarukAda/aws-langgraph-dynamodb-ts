import { nowMs } from '../clock';
import {
  DEFAULT_RETRY_MAX_ATTEMPTS,
  INITIAL_BACKOFF_DELAY_MS,
  MAX_BACKOFF_DELAY_MS,
} from '../constants';
import { DEFAULT_RETRYABLE_ERRORS } from '../errors/classify';
import { retryExhaustedError } from '../errors/errors';
import { toError } from '../errors/to-error';
import { redactedMessage } from '../logging/secret-patterns';
import { abortErrorFrom } from './abort';
import { fullJitter, sleep } from './backoff';
import { isRetryableError } from './retry-classifier';

/**
 * The per-request options one attempt hands to the SDK call it makes.
 *
 * It is the AWS SDK's own second argument (`HttpHandlerOptions` from
 * `@smithy/types`) narrowed to the single field this library sets, so a call
 * site forwards the value it was given instead of assembling one — the
 * difference between `client.get(params, request)` at every site and thirty
 * chances to write `{ signal }` where the SDK reads `abortSignal`.
 *
 * `DynamoDBDocumentLike` picks its members off the real `DynamoDBDocument`, so
 * every method already accepts this as its optional second argument and no
 * type had to move to make room for it.
 */
export interface SdkRequestOptions {
  abortSignal?: AbortSignal;
}

/** What {@link RetryOptions.onRetry} learns before each backoff sleep. */
export interface RetryAttemptInfo {
  attempt: number;
  delayMs: number;
  error: Error;
}

/** Options controlling {@link withRetry}. */
export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryableErrors?: readonly string[];
  /**
   * Decides retryability instead of `retryableErrors`, so a call site can
   * share one classifier (see `isTransientS3Error`) with paths that do not
   * go through `withRetry`.
   */
  isRetryable?: (error: Error) => boolean;
  /** Called before every backoff sleep, so retries are visible before the budget is exhausted. */
  onRetry?: (info: RetryAttemptInfo) => void;
  signal?: AbortSignal;
  rng?: () => number;
  /**
   * @internal Absolute epoch milliseconds past which no further backoff sleep
   * is started, bounding a whole budget rather than a single attempt. Set per
   * call by the paths that carry a client request token, so the retrying ends
   * while that token still deduplicates a re-send; never a caller's option,
   * and absent it nothing about the schedule or the outcome changes.
   */
  deadlineAt?: number;
}

/**
 * Whether sleeping `delayMs` now would carry the budget past `deadlineAt`.
 * No deadline, no bound: the schedule is then exactly what it always was.
 */
function crossesDeadline(deadlineAt: number | undefined, delayMs: number): boolean {
  return deadlineAt !== undefined && nowMs() + delayMs >= deadlineAt;
}

/**
 * End the operation the moment the caller's signal has fired.
 *
 * One function for both observation points — before the first attempt, and
 * after every failed one — so the two can never answer a cancel differently.
 */
function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortErrorFrom(signal);
}

function delayForAttempt(attempt: number, base: number, max: number, rng: () => number): number {
  const exponential = base * 2 ** (attempt - 1);
  return fullJitter(Math.min(exponential, max), rng);
}

interface ResolvedRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  isRetryable: (error: Error) => boolean;
  rng: () => number;
}

/** Apply defaults to {@link RetryOptions}. */
function resolveRetryOptions(options: RetryOptions): ResolvedRetryOptions {
  return {
    maxAttempts: options.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS,
    baseDelayMs: options.baseDelayMs ?? INITIAL_BACKOFF_DELAY_MS,
    maxDelayMs: options.maxDelayMs ?? MAX_BACKOFF_DELAY_MS,
    isRetryable:
      options.isRetryable ??
      ((error) => isRetryableError(error, options.retryableErrors ?? DEFAULT_RETRYABLE_ERRORS)),
    rng: options.rng ?? Math.random,
  };
}

/**
 * Run `fn`, retrying transient failures with full-jitter exponential backoff.
 *
 * Accepts: `fn` — given the {@link SdkRequestOptions} for the attempt, to pass
 * as the second argument of the SDK call it makes. That argument is what
 * carries `options.signal` into the request, and it is the only way a call
 * site can: `fn` closes over its own parameters, so nothing else reaches it.
 * An `fn` that makes no cancellable call ignores the parameter and is written
 * exactly as it was, since a zero-argument function still satisfies the type.
 *
 * Accepts: `options.maxAttempts` — total attempts including the first, default
 * {@link DEFAULT_RETRY_MAX_ATTEMPTS}; at least 1, which `assertRetryPolicy`
 * enforces for every caller-supplied policy. `options.baseDelayMs` /
 * `maxDelayMs` — the backoff schedule. `options.isRetryable` — replaces
 * `retryableErrors` entirely, so a call site can share one classifier with
 * paths that do not go through here. `options.signal` — checked before the
 * first attempt, handed to every attempt as `abortSignal` so the request in
 * flight is cancelled rather than merely awaited, checked again when an
 * attempt fails, and honoured during every backoff wait. `options.onRetry` —
 * called synchronously before each wait; an exception from it is not caught
 * and ends the operation. `options.deadlineAt` — an internal bound on the
 * whole budget rather than on one attempt: the wait that would carry the
 * operation past it is never started, and the budget ends there instead.
 * Without it the schedule, the attempt count and every error are unchanged.
 *
 * Returns: whatever `fn` resolves to, from the first attempt that succeeds.
 *
 * Throws: the error itself, unchanged, when it is not retryable — a
 * `ValidationException` or a permission failure is never retried;
 * `ABORTED` when the signal fires, including during a wait and
 * including while a request is in flight — the SDK rejects the cancelled
 * request with an error of its own, and a failed attempt whose signal has
 * fired is reported as the cancel it is rather than being classified, retried
 * or wrapped; `RETRY_EXHAUSTED` once the budget ends, carrying the attempt
 * actually reached — not the attempts configured — and the last error as
 * `cause`. Its message quotes the last error **redacted**, because it reaches
 * `err.message`, which an application may print without a redacting logger.
 *
 * A deadline that ends the budget is reported exactly as a spent one, by the
 * same error with the same code: a caller cannot tell the two apart, and
 * nothing needs to, since the handling of both is identical — read the row
 * back, and release only what is confirmed not to have landed.
 *
 * A cancelled wait is also an abort no longer observed. The signal is read
 * before the first attempt, after every failed one, and inside each wait, so
 * ending the budget in place of a wait drops only that last observation point:
 * a signal that fires *after* the deadline has already refused the wait, in
 * the window where the wait would have been running, surfaces as
 * `RETRY_EXHAUSTED` rather than `ABORTED`. One already set
 * at entry, fired during an attempt, or fired during an earlier wait, is still
 * caught.
 *
 * Guarantees: `fn` is called at least once and at most `maxAttempts` times. A
 * thrown non-`Error` is wrapped, so what a caller catches is always an `Error`.
 */
export async function withRetry<T>(
  fn: (request: SdkRequestOptions) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs, isRetryable, rng } = resolveRetryOptions(options);

  assertNotAborted(options.signal);

  /**
   * Built once and handed to every attempt. The SDK reads it and keeps
   * nothing, so one object costs one allocation per operation instead of one
   * per attempt, and a re-send cannot differ from the send before it.
   */
  const request: SdkRequestOptions = { abortSignal: options.signal };
  let lastError: Error = new Error('Retry failed without error');
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    try {
      return await fn(request);
    } catch (error) {
      /**
       * Read before the error is classified. A cancelled request rejects with
       * whatever the transport produced — the SDK's own `AbortError` for one
       * cut before the response, a socket error for one cut mid-body — and
       * both would otherwise be classified, retried against a signal that has
       * already fired, and finally reported as a transport failure. A caller
       * who cancelled is owed `ABORTED`, not a diagnosis of its own stop.
       */
      assertNotAborted(options.signal);
      lastError = toError(error as Error);
      if (!isRetryable(lastError)) throw lastError;
      if (attempt === maxAttempts) break;
      const delayMs = delayForAttempt(attempt, baseDelayMs, maxDelayMs, rng);
      if (crossesDeadline(options.deadlineAt, delayMs)) break;
      options.onRetry?.({ attempt, delayMs, error: lastError });
      await sleep(delayMs, options.signal);
    }
  }
  throw retryExhaustedError(
    `Operation failed after ${attempts} attempts: ${redactedMessage(lastError)}`,
    attempts,
    lastError,
  );
}

/**
 * {@link withRetry} with this package's DynamoDB defaults.
 *
 * Accepts: `overrides` — merged over `maxAttempts:`
 * {@link DEFAULT_RETRY_MAX_ATTEMPTS}, so an adapter's resolved policy wins.
 *
 * Returns: as {@link withRetry}.
 *
 * Throws: as {@link withRetry}.
 */
export async function withDynamoDBRetry<T>(
  fn: (request: SdkRequestOptions) => Promise<T>,
  overrides?: Partial<RetryOptions>,
): Promise<T> {
  return withRetry(fn, { maxAttempts: DEFAULT_RETRY_MAX_ATTEMPTS, ...overrides });
}
