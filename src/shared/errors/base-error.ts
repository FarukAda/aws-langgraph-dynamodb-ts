import { ErrorCode } from './error-code';

const ERROR_BRAND = Symbol.for('@farukada/aws-langgraph-dynamodb-ts/error');

/**
 * Structured, log-safe context attached to every library error. Identifiers
 * and counts only — never a payload or a credential.
 */
export interface ErrorContext {
  /** The DynamoDB table the operation targeted, when known. */
  tableName?: string;
  /** The public operation (`saver.put`, `store.batch`, …) or internal step that failed. */
  operation?: string;
  /** The option, argument or cap that failed validation or was exceeded. */
  field?: string;
  /** The S3 object key involved, for offload failures. */
  key?: string;
  /** Attempts made before a retry budget was exhausted. */
  attempts?: number;
  /** The thread a checkpointer failure belongs to. */
  threadId?: string;
  /** The checkpoint a checkpointer failure names. */
  checkpointId?: string;
}

/**
 * Base class for every error this library throws. Carries a branchable
 * {@link ErrorCode}, structured {@link ErrorContext}, and a native `cause`
 * chain. Detected via {@link isDynamoDBLangGraphError} (a symbol brand) rather
 * than `instanceof`, which is banned repo-wide.
 */
export class DynamoDBLangGraphError extends Error {
  readonly code: ErrorCode;
  readonly context: ErrorContext;

  /**
   * Accepts: `message` — already redacted by whoever composed it, since it reaches
   * `err.message`, which an application may print without a redacting logger.
   * `context` — identifiers and counts only, never a payload or a credential.
   * `cause` — the failure below this one, kept as the native `cause` chain.
   *
   * Returns: the error, branded so {@link isDynamoDBLangGraphError} recognises it
   * across realms and across two copies of this package. The brand is
   * non-enumerable, so it never reaches a log or a JSON serialization.
   *
   * Throws: nothing; building an error may not fail.
   */
  constructor(message: string, code: ErrorCode, context: ErrorContext = {}, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DynamoDBLangGraphError';
    this.code = code;
    this.context = context;
    Object.defineProperty(this, ERROR_BRAND, { value: true, enumerable: false });
  }
}

/**
 * Whether `value` is one of this library's errors.
 *
 * Accepts: any error, from any realm or any copy of this package.
 *
 * Returns: whether it carries the brand. A symbol registered by name, not
 * `instanceof`: two copies of this package in one dependency tree produce two
 * classes but one symbol, and an error crossing a realm boundary keeps its
 * properties while losing its prototype.
 *
 * Throws: nothing.
 */
export function isDynamoDBLangGraphError(value: Error): value is DynamoDBLangGraphError {
  return ERROR_BRAND in value;
}
