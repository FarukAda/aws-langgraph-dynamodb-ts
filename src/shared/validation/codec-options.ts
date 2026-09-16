import type { CompressionConfig } from '../codec/compression';
import { assertScopedKeyPrefix, type S3OffloadConfig } from '../codec/s3/config';
import { MAX_INLINE_PAYLOAD_BYTES, MAX_PAYLOAD_BUFFER_BYTES } from '../constants';
import { ValidationError } from '../errors/errors';
import { allKeysOf, assertObjectShape, assertShape } from './option-shape';
import { validateInteger, validateNonEmptyString } from './primitives';

/** Server-side encryption algorithms S3 accepts for `PutObject`. */
const SSE_ALGORITHMS: readonly string[] = ['AES256', 'aws:kms', 'aws:kms:dsse'];

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

/**
 * Validate a `compression` config, honoring its allowed key set.
 *
 * Accepts: `config` — an object naming only {@link CompressionConfig}'s keys.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming the offending field, dotted under
 * `compression`.
 */
export function validateCompression(config: CompressionConfig): void {
  assertShape(config, COMPRESSION_KEYS, 'compression');
  if (typeof config.enabled !== 'boolean') {
    throw new ValidationError('compression.enabled must be a boolean', 'compression.enabled');
  }
  if (config.level !== undefined) {
    validateInteger(config.level, 'compression.level', { min: 0, max: 9 });
  }
  if (config.minSizeBytes !== undefined) {
    /**
     * Bounded by MAX_PAYLOAD_BUFFER_BYTES, not by MAX_INLINE_PAYLOAD_BYTES as
     * `s3.thresholdBytes` is, because the two differ in kind. `encodePayload`
     * compresses first and only then decides inline versus offload, on the
     * compressed size — so `minSizeBytes` above the inline limit, paired with
     * `s3`, is a meaningful configuration: compress only what will be offloaded
     * anyway. A `thresholdBytes` above the inline limit is not: a payload
     * between the two is too large to store inline and too small to offload,
     * so its write fails. `minSizeBytes` only decides whether gzip runs; the
     * only value it can never act on is one larger than any payload this
     * package can read back.
     */
    validateInteger(config.minSizeBytes, 'compression.minSizeBytes', {
      min: 0,
      max: MAX_PAYLOAD_BUFFER_BYTES,
    });
  }
  if (config.maxDecompressedBytes !== undefined) {
    validateInteger(config.maxDecompressedBytes, 'compression.maxDecompressedBytes', {
      min: 1,
      max: MAX_PAYLOAD_BUFFER_BYTES,
    });
  }
}

/**
 * Validate an `s3` offload config, honoring its allowed key set.
 *
 * Accepts: `config` — an object naming only {@link S3OffloadConfig}'s keys.
 * `config.clientConfig`, when given, must be an object that is neither `null`
 * nor an array; its own keys are not checked.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming the offending field, dotted under `s3`.
 */
export function validateS3(config: S3OffloadConfig): void {
  assertShape(config, S3_KEYS, 's3');
  validateNonEmptyString(config.bucketName, 's3.bucketName');
  /**
   * The shape only, never the keys: they are the AWS SDK's `S3ClientConfig`,
   * which gains keys between SDK releases, and an application may install a
   * newer SDK than the one this package was compiled against, so a key list
   * compiled in here would refuse valid configuration.
   */
  if (config.clientConfig !== undefined) assertObjectShape(config.clientConfig, 's3.clientConfig');
  if (config.thresholdBytes !== undefined) {
    validateInteger(config.thresholdBytes, 's3.thresholdBytes', {
      min: 1,
      max: MAX_INLINE_PAYLOAD_BYTES,
    });
  }
  if (config.keyPrefix !== undefined) assertScopedKeyPrefix(config.keyPrefix);
  if (config.maxDownloadBytes !== undefined) {
    validateInteger(config.maxDownloadBytes, 's3.maxDownloadBytes', {
      min: 1,
      max: MAX_PAYLOAD_BUFFER_BYTES,
    });
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
