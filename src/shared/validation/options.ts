import type { CompressionConfig } from '../codec/compression';
import { assertScopedKeyPrefix, type S3OffloadConfig } from '../codec/s3/config';
import { MAX_INLINE_PAYLOAD_BYTES, MAX_RETRY_ATTEMPTS } from '../constants';
import type { RetryPolicy } from '../dynamodb/retry-policy';
import { ValidationError } from '../errors/errors';
import type { BaseAdapterOptions, CodecOptions } from '../options';
import { allKeysOf, assertShape } from './option-shape';
import { validateInteger, validateNonEmptyString } from './primitives';
import { resolveTtlSeconds } from './ttl';

/** DynamoDB's table-name rule: 3–255 characters from `[A-Za-z0-9_.-]`. */
const TABLE_NAME_PATTERN = /^[A-Za-z0-9_.-]{3,255}$/;

/** Server-side encryption algorithms S3 accepts for `PutObject`. */
const SSE_ALGORITHMS: readonly string[] = ['AES256', 'aws:kms', 'aws:kms:dsse'];

const RETRY_KEYS = allKeysOf<RetryPolicy>({
  maxAttempts: 'maxAttempts',
  baseDelayMs: 'baseDelayMs',
  maxDelayMs: 'maxDelayMs',
});
const COMPRESSION_KEYS = allKeysOf<CompressionConfig>({
  enabled: 'enabled',
  level: 'level',
  minSizeBytes: 'minSizeBytes',
  maxDecompressedBytes: 'maxDecompressedBytes',
});
const S3_KEYS = allKeysOf<S3OffloadConfig>({
  bucketName: 'bucketName',
  keyPrefix: 'keyPrefix',
  thresholdBytes: 'thresholdBytes',
  serverSideEncryption: 'serverSideEncryption',
  sseKmsKeyId: 'sseKmsKeyId',
  maxDownloadBytes: 'maxDownloadBytes',
  clientConfig: 'clientConfig',
  createS3Client: 'createS3Client',
});

function validateTableName(tableName: string): void {
  if (typeof tableName !== 'string' || !TABLE_NAME_PATTERN.test(tableName)) {
    throw new ValidationError(
      'tableName must be 3-255 characters from [A-Za-z0-9_.-], as DynamoDB requires',
      'tableName',
    );
  }
}

/**
 * Reject a client choice that names two ways of getting one.
 *
 * Accepts: the three client options, from an adapter or from the factory that
 * defaults them. An injected `client` is used as-is, so a `clientConfig` or
 * `createClient` given alongside it would be silently ignored — including a
 * `region` the caller believes is in effect.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `client`.
 */
export function validateClientChoice(
  options: Pick<BaseAdapterOptions, 'client' | 'clientConfig' | 'createClient'>,
): void {
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

function validateRetryPolicy(policy: RetryPolicy): void {
  assertShape(policy, RETRY_KEYS, 'retry');
  if (policy.maxAttempts !== undefined) {
    validateInteger(policy.maxAttempts, 'retry.maxAttempts', { min: 1, max: MAX_RETRY_ATTEMPTS });
  }
  if (policy.baseDelayMs !== undefined) {
    validateInteger(policy.baseDelayMs, 'retry.baseDelayMs', { min: 1 });
  }
  if (policy.maxDelayMs !== undefined) {
    validateInteger(policy.maxDelayMs, 'retry.maxDelayMs', { min: policy.baseDelayMs ?? 1 });
  }
}

function validateCompression(config: CompressionConfig): void {
  assertShape(config, COMPRESSION_KEYS, 'compression');
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

function validateS3(config: S3OffloadConfig): void {
  assertShape(config, S3_KEYS, 's3');
  validateNonEmptyString(config.bucketName, 's3.bucketName');
  if (config.thresholdBytes !== undefined) {
    validateInteger(config.thresholdBytes, 's3.thresholdBytes', {
      min: 1,
      max: MAX_INLINE_PAYLOAD_BYTES,
    });
  }
  if (config.keyPrefix !== undefined) assertScopedKeyPrefix(config.keyPrefix);
  if (config.maxDownloadBytes !== undefined) {
    validateInteger(config.maxDownloadBytes, 's3.maxDownloadBytes', { min: 1 });
  }
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

/** The recency index: a named GSI, and the partition count rows are sharded across. */
function validateRecencyIndex(options: BaseAdapterOptions): void {
  if (options.indexShards !== undefined) {
    validateInteger(options.indexShards, 'indexShards', { min: 1 });
  }
  if (options.indexName !== undefined) validateNonEmptyString(options.indexName, 'indexName');
}

/**
 * Validate the options every adapter shares, at construction.
 *
 * Accepts: `options` — must be an object. `tableName` is required; every other
 * option is optional, and `undefined` means "not configured" for each. A
 * nested `retry`, `compression` or `s3` must be an object whose keys this
 * package reads: a misspelt key is rejected rather than ignored, because the
 * caller would otherwise run on a default they believe they overrode. Keys of
 * `options` itself are not checked here — the adapter types differ and this
 * validator sees only the shared ones.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError whose `context.field` names the offending option,
 * dotted for a nested one (`s3.bucketName`). The order is `tableName`, client
 * choice, `ttl`, `retry`, `compression`, `s3`, `readConcurrency`, then the
 * index options.
 *
 * Guarantees: a misconfiguration surfaces at construction, naming the option,
 * rather than as a raw AWS error on the first request.
 */
export function validateBaseAdapterOptions(options: BaseAdapterOptions & CodecOptions): void {
  if (typeof options !== 'object' || options === null) {
    throw new ValidationError('options must be an object naming at least a tableName', 'options');
  }
  validateTableName(options.tableName);
  validateClientChoice(options);
  if (options.ttl !== undefined) resolveTtlSeconds(options.ttl);
  if (options.retry !== undefined) validateRetryPolicy(options.retry);
  if (options.compression !== undefined) validateCompression(options.compression);
  if (options.s3 !== undefined) validateS3(options.s3);
  if (options.readConcurrency !== undefined) {
    validateInteger(options.readConcurrency, 'readConcurrency', { min: 1 });
  }
  validateRecencyIndex(options);
}
