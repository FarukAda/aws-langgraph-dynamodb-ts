import type { CompressionConfig } from '../codec/compression';
import type { S3OffloadConfig } from '../codec/s3/config';
import { MAX_INLINE_PAYLOAD_BYTES } from '../constants';
import { ValidationError } from '../errors/errors';
import type { BaseAdapterOptions, CodecOptions } from '../options';
import { validateInteger, validateNonEmptyString } from './primitives';
import { resolveTtlSeconds } from './ttl';

/** DynamoDB's table-name rule: 3–255 characters from `[A-Za-z0-9_.-]`. */
const TABLE_NAME_PATTERN = /^[A-Za-z0-9_.-]{3,255}$/;

/** Server-side encryption algorithms S3 accepts for `PutObject`. */
const SSE_ALGORITHMS: readonly string[] = ['AES256', 'aws:kms', 'aws:kms:dsse'];

function validateTableName(tableName: string): void {
  if (typeof tableName !== 'string' || !TABLE_NAME_PATTERN.test(tableName)) {
    throw new ValidationError(
      'tableName must be 3-255 characters from [A-Za-z0-9_.-], as DynamoDB requires',
      'tableName',
    );
  }
}

/**
 * An injected `client` is used as-is, so a `clientConfig` or `createClient`
 * given alongside it would be silently ignored — including a `region` the
 * caller believes is in effect. Reject the combination instead.
 */
function validateClientChoice(options: BaseAdapterOptions): void {
  if (
    options.client &&
    (options.clientConfig !== undefined || options.createClient !== undefined)
  ) {
    throw new ValidationError(
      'provide either `client` or `clientConfig`/`createClient`, not both: an injected client ' +
        'is used as-is and the configuration would be silently ignored',
      'client',
    );
  }
}

function validateCompression(config: CompressionConfig): void {
  if (typeof config.enabled !== 'boolean') {
    throw new ValidationError('compression.enabled must be a boolean', 'compression.enabled');
  }
  if (config.level !== undefined) {
    validateInteger(config.level, 'compression.level', { min: 0, max: 9 });
  }
  if (config.minSizeBytes !== undefined) {
    validateInteger(config.minSizeBytes, 'compression.minSizeBytes', { min: 0 });
  }
  if (config.maxDecompressedBytes !== undefined) {
    validateInteger(config.maxDecompressedBytes, 'compression.maxDecompressedBytes', { min: 1 });
  }
}

/**
 * The key prefix doubles as the S3 lifecycle rule's `Filter.Prefix`. An empty
 * or root prefix would make that rule expire the whole bucket, and a prefix
 * without a trailing `/` (`app/langgraph`) would also match every sibling
 * object that merely starts with the same characters (`app/langgraph-other/`).
 */
function validateKeyPrefix(keyPrefix: string): void {
  if (keyPrefix === '' || keyPrefix === '/' || !keyPrefix.endsWith('/')) {
    throw new ValidationError(
      's3.keyPrefix must be a non-empty path that ends with "/" (for example "langgraph/"): ' +
        'it scopes both the offloaded objects and the S3 lifecycle rule',
      's3.keyPrefix',
    );
  }
}

function validateS3(config: S3OffloadConfig): void {
  validateNonEmptyString(config.bucketName, 's3.bucketName');
  if (config.thresholdBytes !== undefined) {
    validateInteger(config.thresholdBytes, 's3.thresholdBytes', {
      min: 1,
      max: MAX_INLINE_PAYLOAD_BYTES,
    });
  }
  if (config.keyPrefix !== undefined) validateKeyPrefix(config.keyPrefix);
  if (
    config.serverSideEncryption !== undefined &&
    !SSE_ALGORITHMS.includes(config.serverSideEncryption)
  ) {
    throw new ValidationError(
      `s3.serverSideEncryption must be one of ${SSE_ALGORITHMS.join(', ')}`,
      's3.serverSideEncryption',
    );
  }
}

/**
 * Validate the options every adapter shares, at construction. Each failure is
 * a {@link ValidationError} whose `context.field` names the offending option,
 * so a misconfiguration surfaces where it was written instead of as a raw AWS
 * error on the first request.
 */
export function validateBaseAdapterOptions(options: BaseAdapterOptions & CodecOptions): void {
  validateTableName(options.tableName);
  validateClientChoice(options);
  if (options.ttl !== undefined) resolveTtlSeconds(options.ttl);
  if (options.compression !== undefined) validateCompression(options.compression);
  if (options.s3 !== undefined) validateS3(options.s3);
}
