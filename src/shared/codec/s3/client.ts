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
 * Lazily import the optional `@aws-sdk/client-s3` peer, caching the module. A
 * failed import is not cached, so an install or a fixed bundle can succeed on
 * a later call.
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
 * Construct an `S3Client` from `config` using the lazily-loaded SDK. Defaults
 * `maxAttempts: 1` so the SDK's own internal retries are disabled and this
 * library's retry/backoff/classification system is the sole retry layer,
 * matching {@link resolveDynamoDBClient}'s equivalent default; an explicit
 * `maxAttempts` in `config` still wins.
 */
export async function createDefaultS3Client(config: S3ClientConfigLike): Promise<S3Client> {
  const { S3Client: S3ClientCtor } = await loadS3Sdk();
  return new S3ClientCtor({ maxAttempts: 1, ...config });
}
