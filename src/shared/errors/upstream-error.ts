import { DynamoDBLangGraphError } from './base-error';
import { ErrorCode } from './error-code';

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
export class UpstreamError extends DynamoDBLangGraphError {
  readonly upstreamName: string;
  /** Declared, not emitted: absent metadata leaves no `undefined`-valued own property behind. */
  declare readonly requestId?: string;
  declare readonly httpStatusCode?: number;

  constructor(cause: Error, operation: string) {
    super(
      `${operation}: ${cause.name}: ${cause.message}`,
      ErrorCode.UPSTREAM,
      { operation },
      cause,
    );
    this.name = 'UpstreamError';
    this.upstreamName = cause.name;
    const metadata = (cause as { $metadata?: SdkMetadata }).$metadata;
    if (metadata?.requestId !== undefined) this.requestId = metadata.requestId;
    if (metadata?.httpStatusCode !== undefined) this.httpStatusCode = metadata.httpStatusCode;
  }
}
