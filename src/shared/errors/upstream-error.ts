import { redactedMessage } from '../logging/secret-patterns';
import { truncateForLog } from '../logging/truncate';
import { DynamoDBLangGraphError } from './base-error';
import { ErrorCode } from './error-code';
import { toError } from './to-error';

/** The request metadata an AWS SDK v3 error carries. */
interface SdkMetadata {
  requestId?: string;
  httpStatusCode?: number;
}

/**
 * A failure that originated below this library — the AWS SDK, the transport,
 * a third-party `VectorBackend` or `Embeddings` — and surfaced through one of
 * its public methods. Wrapping it keeps the promise that every rejection a
 * caller sees is a {@link DynamoDBLangGraphError} with a branchable `code`,
 * while losing nothing a support ticket needs: the SDK's own error name, the
 * request id and HTTP status when present, and the original as `cause`.
 */
export class UpstreamError extends DynamoDBLangGraphError<ErrorCode.UPSTREAM> {
  readonly upstreamName: string;
  /** Declared, not emitted: absent metadata leaves no `undefined`-valued own property behind. */
  declare readonly requestId?: string;
  declare readonly httpStatusCode?: number;

  /**
   * Accepts: `cause` — the failure from below: the AWS SDK, the transport, a
   * third-party `VectorBackend` or `Embeddings`. It is caught, not declared, so
   * it may be anything a `throw` produces. `operation` — the public method it
   * surfaced through.
   *
   * Returns: the error, with `code: UPSTREAM`, the SDK's own error name as
   * `upstreamName`, and the request id and HTTP status when the SDK supplied
   * them. Absent metadata leaves no `undefined`-valued own property behind, so
   * a serialized error carries only what is real. A cause that is not
   * error-shaped is described through `toError`, so `cause` is always an
   * `Error` and `upstreamName` always a string. The **message** quotes that
   * name cut at the log cap and the cause's text cut at the relay cap — the
   * two halves of "what the failure was", bounded alike — while
   * `upstreamName` and `cause` keep both whole, because the structured fields
   * are what a caller branches on and the text never was.
   *
   * Throws: nothing; building an error may not fail. Reading `.name` off a
   * thrown string, `null` or plain object crashed here — inside the `catch`
   * whose whole purpose is to report what went wrong.
   */
  constructor(cause: Error, operation: string) {
    /**
     * The cause's text is redacted before it is quoted, exactly as
     * `RetryExhaustedError` and `CompensationFailedError` do. An SDK error can
     * carry a credential fragment in its message — a `SignatureDoesNotMatch`
     * quoting `Credential=AKIA…`, for instance — and this message reaches
     * `err.message`, which an application may print without going through a
     * redacting logger.
     */
    const below = toError(cause);
    super(
      `${operation}: ${truncateForLog(below.name)}: ${redactedMessage(below)}`,
      ErrorCode.UPSTREAM,
      { operation },
      below,
    );
    this.name = 'UpstreamError';
    this.upstreamName = below.name;
    const metadata = (below as { $metadata?: SdkMetadata }).$metadata;
    if (metadata?.requestId !== undefined) this.requestId = metadata.requestId;
    if (metadata?.httpStatusCode !== undefined) this.httpStatusCode = metadata.httpStatusCode;
  }
}
