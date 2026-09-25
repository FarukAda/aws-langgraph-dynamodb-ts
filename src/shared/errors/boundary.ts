/**
 * Hides what crosses the public boundary.
 *
 * Only this package's own error leaves a public method (record 13): an error of
 * its own passes through with the operation named, and anything else — an SDK
 * failure, a caller's thrown value — is classified and wrapped with its cause
 * attached and its text redacted.
 */

import { redactedMessage } from '../logging/secret-patterns';
import { truncateForLog } from '../logging/truncate';
import {
  type AnyDynamoDBLangGraphError,
  DynamoDBLangGraphError,
  isDynamoDBLangGraphError,
  toError,
} from './base-error';
import { awsDiagnostics, classifyAwsError } from './classify';
import { ErrorCode } from './error-code';

/**
 * Normalise anything escaping a public method into the library's error model.
 *
 * Accepts: anything a `catch` produced — an `Error`, or a value that is not one
 * (`toError` settles that first).
 *
 * Returns: a branded library error unchanged, since its code was assigned
 * closer to the failure and wins; anything else wrapped by
 * {@link wrapForeignError}, with the code the classifier assigns.
 *
 * Throws: nothing. It runs inside a `catch`, where throwing would discard the
 * failure being reported and replace it with its own.
 */
export function toPublicError(error: Error, operation: string): AnyDynamoDBLangGraphError {
  const normalized = toError(error);
  return isDynamoDBLangGraphError(normalized)
    ? normalized
    : (wrapForeignError(normalized, operation) as AnyDynamoDBLangGraphError);
}

/**
 * Run a public operation so that every rejection is a library error.
 *
 * Accepts: `operation` — the public method's name, which the wrapped error
 * carries. `fn` — the work.
 *
 * Returns: whatever `fn` resolves to, untouched.
 *
 * Throws: a library error, always. Applied once, at each adapter class method,
 * so internal code can keep rethrowing SDK errors verbatim — the retry
 * classifier depends on their shape, and wrapping them early would blind it.
 */
export async function guardPublic<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toPublicError(error as Error, operation);
  }
}

/**
 * The same guard for a streaming result.
 *
 * Accepts: `operation` — the public method's name. `source` — the generator to
 * relay.
 *
 * Returns: a generator yielding the source's items untouched. A consumer that
 * stops early still closes the source, so an abandoned listing stops reading
 * rather than paging on in the background.
 *
 * Throws: a library error, always — including for a failure raised
 * mid-iteration, which is the case a `try` around the loop body would miss.
 */
export async function* guardPublicIterable<T>(
  operation: string,
  source: AsyncGenerator<T>,
): AsyncGenerator<T> {
  try {
    for await (const item of source) yield item;
  } catch (error) {
    throw toPublicError(error as Error, operation);
  }
}

/** How far {@link classifiableCause} walks a cause chain before giving up. */
const MAX_CAUSE_DEPTH = 32;

/** The one field this module reads off a node while walking its cause chain. */
interface CauseChain {
  cause?: Error;
}

/**
 * The node in `error`'s own cause chain — `error` itself, then its `cause`,
 * then that error's own `cause`, and so on — that {@link classifyAwsError}
 * does not answer `UNEXPECTED_ERROR` for.
 *
 * Accepts: `error` — the outermost foreign failure, already normalised by
 * {@link toError}.
 *
 * Returns: the first node the classifier places under an AWS or network code,
 * so a caller's own error wrapping a modeled SDK exception, or an SDK error
 * whose own `cause` is a raw transport failure, still classifies on the
 * AWS/network failure underneath rather than losing it one level up — the
 * same failure the retry layer's cause-chain walk (`isRetryableError` in
 * `shared/dynamodb/retry.ts`) already sees. `error` itself when
 * nothing in its chain classifies either. The walk gives up after
 * {@link MAX_CAUSE_DEPTH} nodes, and a cycle in the chain stops it rather than
 * looping, exactly as that other walk does.
 *
 * Throws: nothing, for any value {@link toError} can produce.
 */
function classifiableCause(error: Error): Error {
  const seen = new WeakSet<object>();
  let node = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (classifyAwsError(node) !== ErrorCode.UNEXPECTED_ERROR) return node;
    if (typeof node !== 'object' || node === null || seen.has(node)) break;
    seen.add(node);
    const next = (node as CauseChain).cause;
    if (next === undefined) break;
    node = next;
  }
  return error;
}

/**
 * A failure from below this library, as one of its errors.
 *
 * Accepts: `cause` — whatever a `catch` bound: an AWS SDK error, a transport
 * error, or what a `VectorBackend`, `Embeddings`, `serde` or `MultiSessionHistory`
 * threw. `operation` — the public method it surfaced through.
 *
 * Returns: an error whose code is {@link classifyAwsError}'s answer for
 * {@link classifiableCause} of the normalised `cause` — so an AWS or network
 * failure found down the cause chain still earns its own code rather than
 * `UNEXPECTED_ERROR`. Its context names `operation` and — for whichever node
 * was classified — `awsErrorName`, `requestId` and `httpStatusCode`. Its
 * `cause` is the original, normalised through {@link toError}, kept whole
 * regardless of which node down the chain supplied the code. The message
 * quotes the cause's own name cut at the log cap and its own text redacted
 * and cut at the relay cap, because `err.message` reaches applications that
 * print it without a redacting logger.
 *
 * Throws: nothing, for any value.
 */
export function wrapForeignError(cause: Error, operation: string): DynamoDBLangGraphError {
  const below = toError(cause);
  const classifiable = classifiableCause(below);
  return new DynamoDBLangGraphError(
    `${operation}: ${truncateForLog(below.name)}: ${redactedMessage(below)}`,
    classifyAwsError(classifiable),
    { operation, ...awsDiagnostics(classifiable) },
    below,
  );
}
