import type { S3Client } from '@aws-sdk/client-s3';

import { DEFAULT_SOCKET_TIMEOUT_MS } from '../../dynamodb/client';
import { validationError } from '../../errors/errors';
import type { S3ClientConfigLike } from './client-types';

type S3Sdk = typeof import('@aws-sdk/client-s3');

/** Codes Node and bundlers use for an import that cannot be resolved. */
const MISSING_MODULE_CODES: readonly string[] = ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'];

let sdkPromise: Promise<S3Sdk> | undefined;

/**
 * Convert a failed import of the optional peer into a typed error that names
 * the remedy. Any other failure (a broken build, a syntax error inside the
 * package) passes through unchanged.
 */
function wrapMissingPeer(error: Error): never {
  const code = (error as { code?: string }).code;
  if (code !== undefined && MISSING_MODULE_CODES.includes(code)) {
    throw validationError(
      'S3 offload requires the optional peer @aws-sdk/client-s3 (npm install @aws-sdk/client-s3); ' +
        'bundlers must keep it installed or external',
      's3',
      error,
    );
  }
  throw error;
}

/**
 * The optional `@aws-sdk/client-s3` peer, imported on first use.
 *
 * Accepts: nothing. Concurrent callers share one import.
 *
 * Returns: the module, cached for every later call.
 *
 * Throws: `VALIDATION` naming `s3` when the package is not installed,
 * carrying the install command; any other import failure — a broken build, a
 * syntax error inside the package — passes through unchanged. A failure is not
 * cached, so an install or a fixed bundle succeeds on a later call.
 */
export async function loadS3Sdk(): Promise<S3Sdk> {
  if (!sdkPromise) {
    sdkPromise = import('@aws-sdk/client-s3').catch((error: Error) => {
      sdkPromise = undefined;
      return wrapMissingPeer(error);
    });
  }
  return sdkPromise;
}

/**
 * An `S3Client` built from `config` with the lazily-loaded SDK.
 *
 * Accepts: `config` — any `S3ClientConfig`; an explicit `maxAttempts` or
 * `requestHandler` wins over the defaults below.
 *
 * Returns: the client. The caller owns it and destroys it.
 *
 * Throws: whatever {@link loadS3Sdk} throws.
 *
 * Guarantees: `maxAttempts` defaults to 1, so the SDK performs no retries of
 * its own and this library's retry, backoff and classification are the only
 * retry layer — the same default `resolveDynamoDBClient` applies on the
 * DynamoDB side. A default request handler bounds a transfer that has
 * stalled, which `maxAttempts` alone does not; a `requestHandler` in `config`
 * replaces it whole rather than merging with it.
 */
export async function createDefaultS3Client(config: S3ClientConfigLike): Promise<S3Client> {
  const { S3Client: S3ClientCtor } = await loadS3Sdk();
  /**
   * One field, where the DynamoDB client gets three, and the asymmetry is
   * deliberate. `requestTimeout` bounds request creation until response
   * *headers* arrive, and a `PutObject`'s headers arrive only once the whole
   * body has been uploaded — so here it would be a bound on upload duration,
   * over payloads running from the offload threshold to the download cap, and
   * a legitimate large upload on a slow link would be destroyed for being
   * slow. `socketTimeout` is an idle timer that any activity in either
   * direction resets, so it separates a stalled transfer from a slow one.
   * `throwOnRequestTimeout` is absent because without a request timeout it has
   * nothing to act on, and `connectionTimeout` because its timer counts the
   * wait behind the agent's sockets, which this path fans out across.
   *
   * What this bounds is a transfer stalled after its socket was assigned, not
   * the whole attempt: nothing here bounds the time a request spends queued
   * for a socket, and an idle timer is not a deadline, so a large upload's
   * total duration stays unbounded. At or above 2 MiB the SDK sends
   * `Expect: 100-continue` and the handler then waits six seconds for the
   * continue on a throwaway agent, so the five-second idle timer is what
   * fires first — the one place the two timers race.
   */
  return new S3ClientCtor({
    maxAttempts: 1,
    requestHandler: { socketTimeout: DEFAULT_SOCKET_TIMEOUT_MS },
    ...config,
  });
}
