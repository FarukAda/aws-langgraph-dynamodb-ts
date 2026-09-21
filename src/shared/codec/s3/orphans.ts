import { fullJitter, nextBackoffDelay, sleep } from '../../dynamodb/backoff';
import { absorbLoggerFailure, type Logger } from '../../logging/logger';
import { truncateForLog } from '../../logging/truncate';
import type { S3Offloader } from './offloader';
import { isTransientS3Error } from './retry';

const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 100;

/** Options for {@link cleanUpS3Orphans}. */
export interface OrphanCleanupOptions {
  rng?: () => number;
  maxAttempts?: number;
  signal?: AbortSignal;
  /**
   * The row's own leading key parts when `keys` were read back from a row.
   * A key outside the path they produce is never deleted, only reported; own
   * uploads (built by this call) pass no scope.
   */
  scope?: readonly string[];
}

/**
 * Wait out one backoff window, cancellable via `options.signal`. Resolves `true`
 * when the signal aborts the wait (so the caller stops retrying) and `false`
 * otherwise — never rejects, preserving the best-effort, non-throwing contract.
 */
async function backoffSleep(delayMs: number, options: OrphanCleanupOptions): Promise<boolean> {
  try {
    await sleep(fullJitter(delayMs, options.rng), options.signal);
    return false;
  } catch {
    return true;
  }
}

/** Drop every key outside the row's scope, reporting each one. */
function ownedOnly(
  offloader: S3Offloader,
  keys: string[],
  scope: readonly string[],
  context: string,
  logger: Logger,
): string[] {
  return keys.filter((key) => {
    if (offloader.ownsKey(key, scope)) return true;
    absorbLoggerFailure(() =>
      logger.warn(`${context}: refusing to delete an S3 object outside this row's scope`, {
        key: truncateForLog(key),
      }),
    );
    return false;
  });
}

/** The non-empty keys, restricted to the row's scope when one is given. */
function selectOrphans(
  offloader: S3Offloader,
  keys: ReadonlyArray<string | undefined>,
  context: string,
  logger: Logger,
  options: OrphanCleanupOptions,
): string[] {
  const present = keys.filter((key): key is string => typeof key === 'string' && key.length > 0);
  return options.scope ? ownedOnly(offloader, present, options.scope, context, logger) : present;
}
/**
 * Best-effort delete of S3 objects orphaned by a failed DynamoDB write.
 *
 * Accepts: `keys` — may hold `undefined` and empty entries, which are dropped;
 * nothing left means no request. `context` — names the operation in every log
 * line. `options.scope` — the row's own leading key parts when `keys` came from
 * a row: a key outside that path is reported and never deleted. Own uploads
 * pass no scope. `options.maxAttempts` — attempts on a transient failure,
 * default 3. `options.signal` — aborts the wait between attempts.
 *
 * Returns: nothing.
 *
 * Throws: **nothing**, ever. This is the library's sole non-throwing path: a
 * cleanup failure must not mask the write failure that caused it. Every
 * outcome that is not a clean delete is logged at `warn`, carrying counts and
 * the failing error's *name* — never its message, which can hold a credential
 * fragment. A `logger` that throws is one more thing this absorbs (see
 * `absorbLoggerFailure`): the promise covers the caller's own code too,
 * or every call site's `catch` would hand its caller the wrong error. Every
 * logger reaching here through an adapter is already contained at
 * `resolveLogger`; the guard stays because this promise is written without a
 * precondition, and a `logger` is an argument.
 *
 * Guarantees: an object outside the row's scope is never deleted. Leftovers
 * have no automatic backstop — an S3 lifecycle rule sweeps them only if one was
 * provisioned through `ensureS3LifecycleRule()`, which is opt-in.
 */
export async function cleanUpS3Orphans(
  offloader: S3Offloader,
  keys: ReadonlyArray<string | undefined>,
  context: string,
  logger: Logger,
  options: OrphanCleanupOptions = {},
): Promise<void> {
  const orphans = selectOrphans(offloader, keys, context, logger, options);
  if (orphans.length === 0) return;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let delay = BASE_DELAY_MS;
  let lastError = new Error('S3 orphan cleanup did not run');
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const failed = await offloader.deleteBatch(orphans);
      if (failed.length === 0) return;
      /**
       * Absorbed here and not by the `catch` below, which would read a broken
       * logger as a failed delete: the delete succeeded, and only part of it
       * could be reported.
       */
      absorbLoggerFailure(() =>
        logger.warn(
          `Some orphaned S3 objects could not be deleted after ${context}; a lifecycle rule from ensureS3LifecycleRule() would sweep them, otherwise clean up manually`,
          { failedCount: failed.length },
        ),
      );
      return;
    } catch (error) {
      lastError = error as Error;
      if (attempt >= maxAttempts || !isTransientS3Error(lastError)) break;
      if (await backoffSleep(delay, options)) break;
      delay = nextBackoffDelay(delay);
    }
  }
  /**
   * The error's *name*, never its message: an underlying failure can carry a
   * credential fragment in its text, and this package promises that its logs
   * hold identifiers and counts only.
   */
  absorbLoggerFailure(() =>
    logger.warn(
      `Failed to clean up orphaned S3 objects after ${context}; a lifecycle rule from ensureS3LifecycleRule() would sweep them, otherwise clean up manually`,
      { reason: lastError.name },
    ),
  );
}
