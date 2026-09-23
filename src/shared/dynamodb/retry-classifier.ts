import { TRANSIENT_HTTP_STATUSES } from '../errors/classify';
import { transientCancellation } from './cancellation';

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
