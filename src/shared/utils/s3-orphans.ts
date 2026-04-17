/**
 * Best-effort S3 orphan cleanup shared by checkpointer writers.
 *
 * When a DynamoDB write fails *after* payloads have already been uploaded to S3,
 * this helper deletes the uploaded objects so they don't linger until the
 * lifecycle rule sweeps them.
 *
 * Transient S3 errors (503 SlowDown, 500 InternalError, throttling, socket
 * blips) get bounded retries with full-jitter backoff so a single bad minute
 * doesn't leak objects. Persistent failures are only logged — the lifecycle
 * rule is the ultimate backstop and failing the caller's write *after* DDB has
 * already rolled back would add confusion, not safety.
 */

import { getLogger } from './logger';
import type { S3Offloader } from './s3-offloader';
import { fullJitter, sleep } from './sleep';

const ORPHAN_CLEANUP_MAX_ATTEMPTS = 3;
const ORPHAN_CLEANUP_BASE_DELAY_MS = 100;
const ORPHAN_CLEANUP_MAX_DELAY_MS = 2_000;

/** Error codes/names that indicate an S3 request is worth re-issuing. */
const RETRYABLE_S3_SIGNALS: readonly string[] = [
  'SlowDown',
  'InternalError',
  'ServiceUnavailable',
  'RequestTimeout',
  'ThrottlingException',
  'ProvisionedThroughputExceededException',
  // Node-level network transients (also caught by @aws-sdk/client-s3 wrappers).
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'NetworkingError',
  'TimeoutError',
];

function isTransientS3Error(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const signals: string[] = [];
  const e = err as { name?: unknown; code?: unknown; $metadata?: { httpStatusCode?: number } };
  if (typeof e.name === 'string') signals.push(e.name);
  if (typeof e.code === 'string') signals.push(e.code);
  const status = e.$metadata?.httpStatusCode;
  if (typeof status === 'number' && (status === 429 || (status >= 500 && status < 600))) {
    return true;
  }
  return RETRYABLE_S3_SIGNALS.some((s) => signals.some((sig) => sig.includes(s)));
}

export async function cleanUpS3Orphans(
  offloader: S3Offloader,
  keys: ReadonlyArray<string | undefined>,
  context: string,
): Promise<void> {
  const orphans = keys.filter((k): k is string => typeof k === 'string' && k.length > 0);
  if (orphans.length === 0) return;

  let delay = ORPHAN_CLEANUP_BASE_DELAY_MS;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= ORPHAN_CLEANUP_MAX_ATTEMPTS; attempt++) {
    try {
      await offloader.deleteBatch(orphans);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt >= ORPHAN_CLEANUP_MAX_ATTEMPTS || !isTransientS3Error(err)) {
        break;
      }
      await sleep(fullJitter(delay));
      delay = Math.min(delay * 2, ORPHAN_CLEANUP_MAX_DELAY_MS);
    }
  }

  const msg =
    lastErr && typeof lastErr === 'object' && 'message' in lastErr
      ? String((lastErr as { message: unknown }).message)
      : String(lastErr);
  getLogger().warn(
    `Failed to clean up orphaned S3 objects after ${context} ` +
      `(${ORPHAN_CLEANUP_MAX_ATTEMPTS} attempts, lifecycle rule will sweep): ${msg}`,
  );
}
