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

  constructor(message: string, code: ErrorCode, context: ErrorContext = {}, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DynamoDBLangGraphError';
    this.code = code;
    this.context = context;
    Object.defineProperty(this, ERROR_BRAND, { value: true, enumerable: false });
  }
}

/** True when `value` is a {@link DynamoDBLangGraphError}, detected by brand. */
export function isDynamoDBLangGraphError(value: Error): value is DynamoDBLangGraphError {
  return ERROR_BRAND in value;
}
