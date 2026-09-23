import { redactedMessage } from '../logging/secret-patterns';
import { truncateForLog } from '../logging/truncate';
import { DynamoDBLangGraphError } from './base-error';
import { awsDiagnostics, classifyAwsError } from './classify';
import { ErrorCode } from './error-code';
import { toError } from './to-error';

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
 * `shared/dynamodb/retry-classifier.ts`) already sees. `error` itself when
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
 * error, or what a `VectorBackend`, `Embeddings`, `serde` or `SessionBackend`
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
