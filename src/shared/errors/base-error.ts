import { ErrorCode } from './error-code';

const ERROR_BRAND = Symbol.for('@farukada/aws-langgraph-dynamodb-ts/error');

/** Structured, log-safe context attached to every library error. */
export interface ErrorContext {
  tableName?: string;
  operation?: string;
  key?: string;
  attempts?: number;
}

/**
 * Base class for every error this library throws. Carries a branchable
 * {@link ErrorCode}, structured {@link ErrorContext}, and a native `cause`
 * chain. Detected via {@link isDynamoDbLangGraphError} (a symbol brand) rather
 * than `instanceof`, which is banned repo-wide.
 */
export class DynamoDbLangGraphError extends Error {
  readonly code: ErrorCode;
  readonly context: ErrorContext;

  constructor(message: string, code: ErrorCode, context: ErrorContext = {}, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DynamoDbLangGraphError';
    this.code = code;
    this.context = context;
    Object.defineProperty(this, ERROR_BRAND, { value: true, enumerable: false });
  }
}

/** True when `value` is a {@link DynamoDbLangGraphError}, detected by brand. */
export function isDynamoDbLangGraphError(value: Error): value is DynamoDbLangGraphError {
  return ERROR_BRAND in value;
}
