/**
 * Hides what crosses the public boundary.
 *
 * Only this package's own error leaves a public method (record 13): an error of
 * its own passes through, given the public operation and the table it surfaced
 * through for whichever of the two it does not already name, and anything
 * else — an SDK failure, a caller's thrown value — is classified and wrapped
 * with its cause attached and its text redacted.
 */

import { redactedMessage } from '../logging/secret-patterns';
import { truncateForLog } from '../logging/truncate';
import {
  type AnyDynamoDBLangGraphError,
  DynamoDBLangGraphError,
  type ErrorContext,
  isDynamoDBLangGraphError,
  toError,
} from './base-error';
import { awsDiagnostics, classifiableCause, classifyAwsError } from './classify';

/**
 * Fill in where an error surfaced, when it does not say already.
 *
 * `operation` and `tableName` are filled independently: an error already
 * naming an operation — an S3 transfer's `upload` or `download`, or a method
 * a nested adapter call guarded — still gains a table name it lacks, and the
 * reverse holds too. The innermost boundary wins: whichever guarded call
 * first catches the error stamps it, and every guard further out finds both
 * fields already there and changes neither.
 *
 * An error is one object, so it is shared wherever the caller shares it: a
 * signal whose `reason` is already one of this library's own `ABORTED` errors
 * reaches every call that signal cancels as that same instance, and whichever
 * call's boundary reaches it first is the one its `context.operation` (and
 * `context.tableName`) report.
 *
 * Never throws: a context this package cannot write to — frozen, or an older
 * release's own shape — is left as it was, and a context that accepts only some
 * of the writes (one sealed while already holding an `operation` key, say, which
 * takes `operation` but refuses a new `tableName`) keeps the fields written
 * before the first refusal, since this runs inside the one place a public
 * method's own `catch` would otherwise have the failure it is reporting
 * replaced by whatever this raised instead.
 */
function stampContext(
  error: AnyDynamoDBLangGraphError,
  operation: string,
  tableName: string | undefined,
): void {
  const context = error.context as ErrorContext | undefined;
  if (typeof context !== 'object' || context === null) return;
  try {
    context.operation ??= operation;
    if (tableName !== undefined) context.tableName ??= tableName;
  } catch {
    // As documented above: best-effort, and this function may not throw.
  }
}

/**
 * Normalise anything escaping a public method into the library's error model.
 *
 * Accepts: anything a `catch` produced — an `Error`, or a value that is not one
 * (`toError` settles that first). `operation` — the public method's name.
 * `tableName` — the adapter's table, when the method has one.
 *
 * Returns: a branded library error — the same one, when it already was one,
 * with whichever of `context.operation` and `context.tableName` it does not
 * already carry filled in — or anything else wrapped by {@link wrapForeignError}
 * with the code the classifier assigns, stamped the same way.
 *
 * Throws: nothing. It runs inside a `catch`, where throwing would discard the
 * failure being reported and replace it with its own.
 */
export function toPublicError(
  error: Error,
  operation: string,
  tableName?: string,
): AnyDynamoDBLangGraphError {
  const normalized = toError(error);
  const publicError = isDynamoDBLangGraphError(normalized)
    ? normalized
    : (wrapForeignError(normalized, operation) as AnyDynamoDBLangGraphError);
  stampContext(publicError, operation, tableName);
  return publicError;
}

/**
 * Run a public operation so that every rejection is a library error.
 *
 * Accepts: `operation` — the public method's name, which the error carries.
 * `fn` — the work. `tableName` — the adapter's table, which the error carries.
 *
 * Returns: whatever `fn` resolves to, untouched.
 *
 * Throws: a library error, always. Applied once, at each adapter class method,
 * so internal code can keep rethrowing SDK errors verbatim — the retry
 * classifier depends on their shape, and wrapping them early would blind it.
 */
export async function guardPublic<T>(
  operation: string,
  fn: () => Promise<T>,
  tableName?: string,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toPublicError(error as Error, operation, tableName);
  }
}

/**
 * The same guard for a streaming result.
 *
 * Accepts: `operation` — the public method's name. `source` — the generator to
 * relay. `tableName` — the adapter's table.
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
  tableName?: string,
): AsyncGenerator<T> {
  try {
    for await (const item of source) yield item;
  } catch (error) {
    throw toPublicError(error as Error, operation, tableName);
  }
}

/**
 * The same guard for a synchronous public method.
 *
 * Accepts: `operation` — the public method's name. `fn` — the work.
 * `tableName` — the adapter's table.
 *
 * Returns: whatever `fn` returns.
 *
 * Throws: a library error, always — what a client's own `destroy` threw
 * included, classified like any other foreign failure and kept as `cause`.
 */
export function guardPublicSync<T>(operation: string, fn: () => T, tableName?: string): T {
  try {
    return fn();
  } catch (error) {
    throw toPublicError(error as Error, operation, tableName);
  }
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
