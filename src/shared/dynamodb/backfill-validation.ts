import { MAX_INDEX_SHARDS } from '../constants';
import { validationError } from '../errors/errors';
import { assertMembers, assertSignalLike } from '../validation/collaborators';
import { allKeysOf, assertShape } from '../validation/option-shape';
import { validateRetryBounds, validateTableName } from '../validation/options';
import { validateInteger, validateStringArray } from '../validation/primitives';
import type { BackfillOptions } from './backfill-types';
import type { RetryOptions } from './retry';

/**
 * The keys of {@link BackfillOptions}, exhaustive in both directions —
 * `allKeysOf<T>` fails to compile if this list omits or invents one.
 */
const BACKFILL_KEYS = allKeysOf<BackfillOptions>({
  client: 'client',
  tableName: 'tableName',
  indexShards: 'indexShards',
  pageSize: 'pageSize',
  maxPages: 'maxPages',
  cursor: 'cursor',
  dryRun: 'dryRun',
  retry: 'retry',
  signal: 'signal',
});

/** The `DynamoDBDocument` methods the backfill calls on an injected `client`. */
const BACKFILL_CLIENT_MEMBERS: readonly string[] = ['scan', 'update'];

/**
 * The keys of {@link RetryOptions}, exhaustive in both directions. Backfill
 * accepts the full retry surface, not the adapters' narrower `RetryPolicy`
 * `validateRetryPolicy` checks — `onRetry` is backfill's only way to observe
 * retries, since it takes no `logger`.
 *
 * `deadlineAt` is the one exclusion: it is an internal per-call bound a write
 * path sets on itself, not something an application names, so it stays an
 * unknown key here and is refused like any other. Excluding it by `Omit`
 * rather than by leaving it out keeps the list exhaustive, so a genuinely new
 * option still fails to compile until it is decided on here.
 */
const BACKFILL_RETRY_KEYS = allKeysOf<Omit<RetryOptions, 'deadlineAt'>>({
  maxAttempts: 'maxAttempts',
  baseDelayMs: 'baseDelayMs',
  maxDelayMs: 'maxDelayMs',
  retryableErrors: 'retryableErrors',
  isRetryable: 'isRetryable',
  onRetry: 'onRetry',
  signal: 'signal',
  rng: 'rng',
});

/**
 * Validate a `backfillRecencyIndex` retry policy against the full
 * {@link RetryOptions} surface.
 *
 * Accepts: `retry` — must be an object naming only {@link BACKFILL_RETRY_KEYS}.
 * `maxAttempts`/`baseDelayMs`/`maxDelayMs` share the adapters' own bounds
 * ({@link validateRetryBounds}), so backfill and the adapters it feeds cannot
 * drift apart on what a legal value is. `retryableErrors`, when given, must be
 * an array of strings. `isRetryable`, `onRetry` and `rng`, when given, must
 * each be a function. `signal` is checked the same way the top-level
 * `options.signal` is. Either one cancels the run; when both are given the
 * top-level one wins, since the caller's own signal is meant to cancel the
 * whole operation.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `retry`, `retry.<numeric key>`,
 * `retry.retryableErrors`, `retry.isRetryable`, `retry.onRetry`, `retry.rng`
 * or `retry.signal`.
 */
function validateBackfillRetryOptions(retry: RetryOptions): void {
  assertShape(retry, BACKFILL_RETRY_KEYS, 'retry');
  validateRetryBounds(retry);
  if (retry.retryableErrors !== undefined) {
    validateStringArray(retry.retryableErrors, 'retry.retryableErrors');
  }
  if (retry.isRetryable !== undefined && typeof retry.isRetryable !== 'function') {
    throw validationError('retry.isRetryable must be a function', 'retry.isRetryable');
  }
  if (retry.onRetry !== undefined && typeof retry.onRetry !== 'function') {
    throw validationError('retry.onRetry must be a function', 'retry.onRetry');
  }
  if (retry.rng !== undefined && typeof retry.rng !== 'function') {
    throw validationError('retry.rng must be a function', 'retry.rng');
  }
  assertSignalLike(retry.signal, 'retry.signal');
}

/**
 * Reject a non-integer positive bound, `undefined` left to its own default.
 *
 * Accepts: `value` — `options.pageSize`, `options.maxPages` or
 * `options.indexShards`, as the caller gave it. `field` — what the error
 * names. `max` — an upper bound, when one applies.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `field` — including for `null`, which is a
 * caller's explicit (wrong) value, not "unset", so it is refused rather than
 * silently falling through to the default the way `??` alone would.
 */
function validatePositiveBound(value: number | undefined, field: string, max?: number): void {
  if (value === undefined) return;
  validateInteger(value, field, max === undefined ? { min: 1 } : { min: 1, max });
}

/**
 * Validate every option `backfillRecencyIndex` reads, before any of them is
 * read for real.
 *
 * Accepts: `options` — must be an object naming only the nine keys
 * {@link BackfillOptions} declares. `tableName` and `client` are required, the
 * rest optional; each, when given, follows the same rule an adapter's own
 * option of the same name does. `tableName` reuses the adapters' own
 * `tableName` validator outright; `indexShards` is held to the adapters'
 * shard cap, `MAX_INDEX_SHARDS`; and `retry` shares its numeric bounds with
 * the adapters' own `retry` validator while accepting the wider surface
 * backfill's `RetryOptions` needs, so a mismatch between backfill and the
 * adapters it feeds cannot drift in on what a bound means.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `options.<key>` for an unknown key;
 * `tableName`; `client` or `client.<member>`; `indexShards`, `pageSize` or
 * `maxPages` for a non-positive-integer bound (`indexShards` is additionally
 * capped); `dryRun` for a non-boolean; `retry`/`retry.<key>`; `signal`.
 */
export function validateBackfillOptions(options: BackfillOptions): void {
  assertShape(options, BACKFILL_KEYS, 'options');
  validateTableName(options.tableName);
  assertMembers(options.client, BACKFILL_CLIENT_MEMBERS, 'client');
  validatePositiveBound(options.indexShards, 'indexShards', MAX_INDEX_SHARDS);
  validatePositiveBound(options.pageSize, 'pageSize');
  validatePositiveBound(options.maxPages, 'maxPages');
  if (options.dryRun !== undefined && typeof options.dryRun !== 'boolean') {
    throw validationError('dryRun must be a boolean', 'dryRun');
  }
  if (options.retry !== undefined) validateBackfillRetryOptions(options.retry);
  assertSignalLike(options.signal);
}
