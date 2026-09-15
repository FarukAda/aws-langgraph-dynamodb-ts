import type { S3Client } from '@aws-sdk/client-s3';

import { ValidationError } from '../../errors/errors';
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
    throw new ValidationError(
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
 * Throws: ValidationError naming `s3` when the package is not installed,
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
 * Accepts: `config` — any `S3ClientConfig`; an explicit `maxAttempts` wins over
 * the default below.
 *
 * Returns: the client. The caller owns it and destroys it.
 *
 * Throws: whatever {@link loadS3Sdk} throws.
 *
 * Guarantees: `maxAttempts` defaults to 1, so the SDK performs no retries of
 * its own and this library's retry, backoff and classification are the only
 * retry layer — the same default `resolveDynamoDBClient` applies on the
 * DynamoDB side.
 */
export async function createDefaultS3Client(config: S3ClientConfigLike): Promise<S3Client> {
  const { S3Client: S3ClientCtor } = await loadS3Sdk();
  return new S3ClientCtor({ maxAttempts: 1, ...config });
}
