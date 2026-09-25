/**
 * Hides when and how a failed request is retried (record 14).
 *
 * Which failures are transient — read from an error's whole cause chain, its
 * HTTP status and its retryable trait, and from a cancelled transaction's
 * reasons — the full-jitter backoff schedule, the attempt budget and the
 * deadline that can cut it short, and the policy an adapter resolves from its
 * options at construction are one decision. Every DynamoDB call goes through
 * it, and so does an S3 object upload and download; the bucket lifecycle calls
 * (`maxAttempts: 1` on the S3 client) and orphan release, which retries on its
 * own loop, do not.
 */

import { nowMs } from '../clock';
import { failureLabel, toError } from '../errors/base-error';
import { DEFAULT_RETRYABLE_ERRORS, TRANSIENT_HTTP_STATUSES } from '../errors/classify';
import { retryExhaustedError } from '../errors/errors';
import type { Logger } from '../logging/logger';
import { redactedMessage } from '../logging/secret-patterns';
import { truncateForLog } from '../logging/truncate';
import { abortErrorFrom } from './abort';
import { transientCancellation } from './cancellation';

/** Starting delay for UnprocessedItems / UnprocessedKeys backoff loops. */
export const INITIAL_BACKOFF_DELAY_MS = 100;

/** Maximum backoff delay for retry loops. */
export const MAX_BACKOFF_DELAY_MS = 5000;

/** Default maximum attempts for transient-error retries. */
export const DEFAULT_RETRY_MAX_ATTEMPTS = 5;

/**
 * How long DynamoDB treats a repeated client request token as the same request
 * rather than a new one, so re-sending a tokened write is deduplicated instead
 * of applied twice (10 minutes). Recorded as its own constant so the margin
 * {@link MAX_WRITE_LIFETIME_MS} keeps under it is legible.
 */
export const TOKEN_IDEMPOTENCY_WINDOW_MS = 600_000;

/**
 * Longest one token-carrying write may keep retrying (5 minutes): half of
 * {@link TOKEN_IDEMPOTENCY_WINDOW_MS}. The other half absorbs the attempt
 * still in flight when the budget ends, clock skew between this client's own
 * clock and DynamoDB's timer, and SDK-internal queueing, so a write that
 * retries to the end still finishes well inside the window its token is
 * honoured for. Its own literal rather than a division of the window:
 * aliasing them would move one whenever the other is retuned (see
 * `LIST_SCAN_WARN_THRESHOLD` (`src/shared/dynamodb/paginate.ts`)).
 */
export const MAX_WRITE_LIFETIME_MS = 300_000;

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

/**
 * How a failed request is retried: how many attempts, how long each wait, and
 * which failures qualify.
 */
export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryableErrors?: readonly string[];
  /**
   * Decides retryability instead of `retryableErrors`: called with each failed
   * attempt's error, it retries when it returns `true`.
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

  // Built once and handed to every attempt. The SDK reads it and keeps
  // nothing, so one object costs one allocation per operation instead of one
  // per attempt, and a re-send cannot differ from the send before it.
  const request: SdkRequestOptions = { abortSignal: options.signal };
  let lastError: Error = new Error('Retry failed without error');
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    try {
      return await fn(request);
    } catch (error) {
      // Read before the error is classified. A cancelled request rejects with
      // whatever the transport produced — the SDK's own `AbortError` for one
      // cut before the response, a socket error for one cut mid-body — and
      // both would otherwise be classified, retried against a signal that has
      // already fired, and finally reported as a transport failure. A caller
      // who cancelled is owed `ABORTED`, not a diagnosis of its own stop.
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

const MAX_CAUSE_DEPTH = 32;

/** What the cause chain says about an error: exact signal tokens, HTTP statuses, retryable trait. */
interface RetryEvidence {
  signals: string[];
  statuses: number[];
  retryableByTrait: boolean;
}

interface ErrorFields {
  name?: string;
  code?: string;
  errno?: string;
  syscall?: string;
  cause?: Error;
  $metadata?: { httpStatusCode?: number };
  $retryable?: object;
}

/** Add one node's signal tokens, HTTP status and retryable trait to `evidence`. */
function recordNode(fields: ErrorFields, evidence: RetryEvidence): void {
  for (const value of [fields.name, fields.code, fields.errno, fields.syscall]) {
    if (typeof value === 'string') evidence.signals.push(value);
  }
  if (typeof fields.$metadata?.httpStatusCode === 'number') {
    evidence.statuses.push(fields.$metadata.httpStatusCode);
  }
  if (fields.$retryable !== undefined && fields.$retryable !== null)
    evidence.retryableByTrait = true;
}

function collectEvidence(error: Error): RetryEvidence {
  const seen = new WeakSet<object>();
  const evidence: RetryEvidence = { signals: [], statuses: [], retryableByTrait: false };
  const walk = (node: Error, depth: number): void => {
    if (depth > MAX_CAUSE_DEPTH || node === null || typeof node !== 'object' || seen.has(node)) {
      return;
    }
    seen.add(node);
    const fields = node as ErrorFields;
    recordNode(fields, evidence);
    if (fields.cause) walk(fields.cause, depth + 1);
  };
  walk(error, 0);
  return evidence;
}

/**
 * Whether `error`, or any cause in its chain, is transient.
 *
 * Accepts: `error` — an `Error`; its `cause` chain is walked to
 * {@link MAX_CAUSE_DEPTH}, and a cycle in it terminates the walk rather than
 * looping. Anything else a `throw` can produce carries no node to walk and is
 * not retryable. `retryableErrors` — the signal tokens to match; an empty list
 * still admits the trait and status rules below.
 *
 * Returns: true when any of these holds, in this order —
 * 1. the error is a transaction cancellation and **every** reason it carries is
 *    transient. This verdict is final either way: a permanent reason arrives
 *    with the same HTTP status as a transient one, so the later rules cannot be
 *    allowed to overturn it. A cancellation carrying no reasons is not retried.
 * 2. any node carries the SDK's `$retryable` trait;
 * 3. any node's HTTP status is in {@link TRANSIENT_HTTP_STATUSES} — which is
 *    what classifies a failure the SDK could not map to a modeled exception,
 *    arriving as `name: 'Unknown'` with only a status;
 * 4. any node's `name`, `code`, `errno` or `syscall` equals a token in
 *    `retryableErrors`.
 *
 * The token match is exact, never substring: these fields are whole tokens, and
 * a substring rule would let an unrelated name that merely contains one ride
 * along.
 *
 * Throws: **nothing**, for any value a `throw` can produce — see
 * {@link transientCancellation}, which the first rule reads through.
 */
export function isRetryableError(error: Error, retryableErrors: readonly string[]): boolean {
  const cancellation = transientCancellation(error);
  if (cancellation !== undefined) return cancellation;
  const evidence = collectEvidence(error);
  if (evidence.retryableByTrait) return true;
  if (evidence.statuses.some((status) => TRANSIENT_HTTP_STATUSES.includes(status))) return true;
  return evidence.signals.some((signal) => retryableErrors.includes(signal));
}

/**
 * Caller-facing retry tunables for every DynamoDB call an adapter makes. The
 * schedule is full-jitter exponential backoff: `baseDelayMs` doubling per
 * attempt, capped at `maxDelayMs`, for `maxAttempts` attempts. The
 * message-append path never goes below its own contention floor.
 */
export interface RetryPolicy {
  /** Attempts per call before `RETRY_EXHAUSTED` (default 5). */
  maxAttempts?: number;
  /** First backoff delay in milliseconds (default 100). */
  baseDelayMs?: number;
  /** Cap on a single backoff delay in milliseconds (default 5000). */
  maxDelayMs?: number;
}

/** A policy with every field defaulted, before the logger is attached to it. */
interface ResolvedPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * The nominal worst case of a policy's backoff schedule, in milliseconds.
 *
 * `withRetry` sleeps *between* attempts, so a budget of `maxAttempts` attempts
 * holds `maxAttempts - 1` sleeps, and full jitter draws the k-th of them from
 * `[0, min(baseDelayMs * 2 ** (k - 1), maxDelayMs))`. The worst case is
 * therefore the **sum of those caps**:
 *
 * `sum over k in 1..maxAttempts-1 of min(baseDelayMs * 2 ** (k - 1), maxDelayMs)`
 *
 * It is stated here because the reading a reader reaches for —
 * `maxAttempts * maxDelayMs` — is wrong in both directions at once: it counts
 * a sleep after the final attempt, which never happens, and it charges the cap
 * for every early sleep the exponential has not yet climbed to. At the
 * defaults - five attempts, so four sleeps - they total 1.5 s where the naive
 * reading says 25 s.
 *
 * Nominal, not actual: each sleep is drawn uniformly below its cap, so a real
 * budget averages about half of this and only approaches it in the limit. The
 * cap is what a bound has to be measured against all the same.
 */
function nominalBudgetMs(policy: ResolvedPolicy): number {
  let total = 0;
  for (let sleep = 1; sleep < policy.maxAttempts; sleep++) {
    total += Math.min(policy.baseDelayMs * 2 ** (sleep - 1), policy.maxDelayMs);
  }
  return total;
}

/**
 * Warn when a policy's nominal budget outlives {@link MAX_WRITE_LIFETIME_MS},
 * the deadline every token-carrying write in this package runs under.
 *
 * Warn, never refuse. A long policy is the caller's own choice, it stays
 * legal, and the deadline already makes it safe — what it is not, without this
 * line, is visible: a deadline that ends a budget early and a budget that is
 * simply spent both surface as the same `RETRY_EXHAUSTED` error, so the first
 * evidence that a configured policy can never run to its end would otherwise
 * be an incident. Said once, at construction, it is said before the first
 * write rather than after.
 */
function warnIfOutlivesWriteLifetime(policy: ResolvedPolicy, logger: Logger): void {
  const budgetMs = nominalBudgetMs(policy);
  if (budgetMs <= MAX_WRITE_LIFETIME_MS) return;
  logger.warn('retry policy outlives the write lifetime; the budget will be cut short', {
    budgetMs,
    maxWriteLifetimeMs: MAX_WRITE_LIFETIME_MS,
  });
}

/**
 * Resolve an adapter's retry policy once, at construction.
 *
 * Accepts: `policy` — the caller's, already validated, or nothing. `logger` —
 * the adapter's resolved logger.
 *
 * Returns: the options every DynamoDB call of that adapter uses, with each
 * field defaulted and the logger attached, so every retry is visible at `debug`
 * (the attempt, the delay about to be slept, the error's name) instead of only
 * surfacing once the budget is exhausted.
 *
 * Accepts: `attemptFloor` — the lowest attempt count this adapter will actually
 * use, when it raises a caller's below its own. The budget is warned about at
 * that number rather than at the caller's, because it is the one the writes
 * will really spend; an adapter that honours the caller's count passes none.
 *
 * Throws: nothing; the policy was validated where it was given. A policy whose
 * nominal budget outlives {@link MAX_WRITE_LIFETIME_MS} is warned about rather
 * than refused, once per adapter constructed — three adapters built from one
 * long policy each say so for themselves — see
 * {@link warnIfOutlivesWriteLifetime}. The defaults are far inside it and say
 * nothing.
 */
export function resolveRetryPolicy(
  policy: RetryPolicy | undefined,
  logger: Logger,
  attemptFloor = 0,
): RetryOptions {
  const resolved = {
    maxAttempts: policy?.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS,
    baseDelayMs: policy?.baseDelayMs ?? INITIAL_BACKOFF_DELAY_MS,
    maxDelayMs: policy?.maxDelayMs ?? MAX_BACKOFF_DELAY_MS,
  };
  // Measured at the attempts the adapter will really make, not at the ones the
  // caller wrote. The history append raises a caller's count to its own floor
  // while keeping the caller's delays, so a policy that only raises
  // `maxDelayMs` produces a budget far past the deadline and would otherwise
  // be warned about nowhere. An adapter with no floor passes none.
  warnIfOutlivesWriteLifetime(
    { ...resolved, maxAttempts: Math.max(resolved.maxAttempts, attemptFloor) },
    logger,
  );
  return {
    ...resolved,
    // The name, never the message — and bounded: the transient failure came
    // from the SDK, the transport or a caller's own collaborator, and nothing
    // this package ran checked how long its name is. This line fires once per
    // retry, so an unbounded one is paid for per attempt.
    onRetry: ({ attempt, delayMs, error }) =>
      logger.debug('retrying after a transient error', {
        attempt,
        delayMs,
        error: truncateForLog(failureLabel(error)),
      }),
  };
}

/**
 * The context's retry options plus a per-call cancellation signal.
 *
 * Accepts: `context.retry` — the adapter's resolved policy. `signal` — the
 * caller's, when the call takes one.
 *
 * Returns: the adapter's options untouched when there is no signal — the same
 * object, so no per-call allocation on the common path — and a copy carrying it
 * when there is.
 *
 * Throws: nothing.
 */
export function retryFor(
  context: { retry?: RetryOptions },
  signal?: AbortSignal,
): RetryOptions | undefined {
  return signal === undefined ? context.retry : { ...context.retry, signal };
}

/**
 * Wait `ms` milliseconds, cancellable.
 *
 * Accepts: `ms` — the delay. `signal` — omitted waits uninterruptibly; already
 * aborted rejects before any timer is set; aborting while pending rejects at
 * that moment and clears the timer.
 *
 * Returns: a promise resolving when the delay elapses.
 *
 * Throws: an `ABORTED` error however the signal was aborted —
 * with a `DOMException`, a string or a custom reason (see
 * {@link abortErrorFrom}).
 *
 * Guarantees: exactly one of resolve and reject runs, and neither the timer nor
 * the abort listener outlives the call. The listener is attached before the
 * timer is armed, so a signal whose `addEventListener` throws rejects the wait
 * with nothing left behind — armed first, the timer outlived that rejection
 * and later called `removeEventListener` outside any promise. A listener that
 * runs while it is being attached settles the wait before any timer exists.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortErrorFrom(signal));
  }
  return new Promise((resolve, reject) => {
    // One holder for both flags, declared before `onAbort` reads the timer:
    // the timer is assigned only once armed, after the listener is attached.
    const wait: { settled: boolean; timer?: ReturnType<typeof setTimeout> } = { settled: false };
    const onAbort = (): void => {
      if (wait.settled) return;
      wait.settled = true;
      clearTimeout(wait.timer);
      reject(abortErrorFrom(signal as AbortSignal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (wait.settled) return;
    wait.timer = setTimeout(() => {
      if (wait.settled) return;
      wait.settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
  });
}

/**
 * The next exponential-backoff delay.
 *
 * Accepts: `currentMs` — the delay just used; at least 1, since doubling 0
 * never grows. `maxMs` — the ceiling, default {@link MAX_BACKOFF_DELAY_MS}.
 *
 * Returns: `min(currentMs * 2, maxMs)`.
 *
 * Throws: nothing.
 */
export function nextBackoffDelay(currentMs: number, maxMs: number = MAX_BACKOFF_DELAY_MS): number {
  return Math.min(currentMs * 2, maxMs);
}

/**
 * AWS's full jitter over a backoff delay.
 *
 * Accepts: `delayMs` — the unjittered delay. `rng` — a seam returning
 * `[0, 1)`, default `Math.random`; tests inject a fixed one.
 *
 * Returns: a value in `[0, delayMs)`, so two clients retrying the same failure
 * do not retry together
 * (https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/).
 *
 * Throws: nothing.
 */
export function fullJitter(delayMs: number, rng: () => number = Math.random): number {
  return rng() * delayMs;
}

/**
 * Whether `error` is a transient S3 failure worth retrying.
 *
 * Accepts: `error` — any error, including one carrying no name or code, and
 * equally anything else a `throw` can produce.
 *
 * Returns: {@link isRetryableError} over the shared default tokens, which hold
 * S3's own transient names (`SlowDown`, `InternalError`,
 * `ConditionalRequestConflict`) alongside DynamoDB's — one list, so the two
 * services cannot drift apart on what is transient.
 *
 * Throws: **nothing**, for any value; {@link isRetryableError} is total.
 */
export function isTransientS3Error(error: Error): boolean {
  return isRetryableError(error, DEFAULT_RETRYABLE_ERRORS);
}
