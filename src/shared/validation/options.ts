/**
 * Hides which adapter-wide construction options are accepted.
 *
 * The table name, the client choice, the ttl, the retry policy, the recency
 * index, the read concurrency, compression and S3 offload are checked here with
 * their bounds, before an adapter builds anything, so a misconfiguration
 * surfaces at construction rather than on the first call.
 */

import type { CompressionConfig } from '../codec/compression';
import { assertScopedKeyPrefix, type S3OffloadConfig } from '../codec/s3/config';
import {
  MAX_INDEX_SHARDS,
  MAX_INLINE_PAYLOAD_BYTES,
  MAX_PAYLOAD_BUFFER_BYTES,
  MAX_READ_CONCURRENCY,
  MAX_RETRY_ATTEMPTS,
  MAX_RETRY_DELAY_MS,
} from '../constants';
import type { RetryPolicy } from '../dynamodb/retry';
import { validationError } from '../errors/errors';
import type { BaseAdapterOptions, CodecOptions } from '../options';
import { allKeysOf, assertObjectShape, assertShape } from './option-shape';
import { assertInteger, assertNonEmptyString } from './primitives';
import { resolveTtlSeconds } from './ttl';

/** DynamoDB's table-name rule: 3–255 characters from `[A-Za-z0-9_.-]`. */
const TABLE_NAME_PATTERN = /^[A-Za-z0-9_.-]{3,255}$/;

const RETRY_KEYS = allKeysOf<RetryPolicy>({
  maxAttempts: 'maxAttempts',
  baseDelayMs: 'baseDelayMs',
  maxDelayMs: 'maxDelayMs',
});

/**
 * Validate a table name against DynamoDB's own naming rule.
 *
 * Accepts: `tableName` — as the caller gave it.
 *
 * Returns: nothing: the value is kept under its declared type, and this
 * checks it.
 *
 * Throws: `VALIDATION` naming `tableName`.
 */
export function assertTableName(tableName: string): void {
  if (typeof tableName !== 'string' || !TABLE_NAME_PATTERN.test(tableName)) {
    throw validationError(
      'tableName must be 3-255 characters from [A-Za-z0-9_.-], as DynamoDB requires',
      'tableName',
    );
  }
}

/**
 * Reject a client choice that names two ways of getting one, or a
 * `clientConfig` that is not an object.
 *
 * Accepts: the three client options, from an adapter or from the factory that
 * defaults them. An injected `client` is used as-is, so a `clientConfig` or
 * `createClient` given alongside it would be silently ignored — including a
 * `region` the caller believes is in effect. `clientConfig`, when given, must
 * be an object that is neither `null` nor an array; what it holds is the AWS
 * SDK's to judge.
 *
 * Returns: nothing: the value is kept under its declared type, and this
 * checks it.
 *
 * Throws: `VALIDATION` naming `client` for both ways at once, then
 * `clientConfig` for one that is not an object.
 */
export function assertClientChoice(
  options: Pick<BaseAdapterOptions, 'client' | 'clientConfig' | 'createClient'>,
): void {
  if (
    options.client &&
    (options.clientConfig !== undefined || options.createClient !== undefined)
  ) {
    throw validationError(
      'provide either `client` or `clientConfig`/`createClient`, not both: an injected client ' +
        'is used as-is and the configuration would be silently ignored',
      'client',
    );
  }
  /**
   * The shape only, never the keys, and on purpose: they are the AWS SDK's
   * `DynamoDBClientConfig`, which gains keys between SDK releases, and an
   * application may install a newer SDK than the one this package was
   * compiled against, so a key list compiled in here would refuse valid
   * configuration. The SDK reads each key itself.
   */
  if (options.clientConfig !== undefined) assertObjectShape(options.clientConfig, 'clientConfig');
}

/**
 * The three numeric bounds every retry policy shares, regardless of which
 * other keys the caller's own type allows beyond them. Split out so a caller
 * with a wider surface than {@link RetryPolicy} (`backfillRecencyIndex`'s
 * `RetryOptions`, which also exposes `onRetry`, `isRetryable` and friends)
 * can reuse the identical bounds without going through {@link
 * assertRetryPolicy}'s narrower `assertShape`, which would refuse those
 * extra keys outright.
 *
 * Accepts: `policy` — its `maxAttempts`, `baseDelayMs` and `maxDelayMs`, each
 * optional.
 *
 * Returns: nothing: the value is kept under its declared type, and this
 * checks it.
 *
 * Throws: `VALIDATION` naming `retry.maxAttempts`, `retry.baseDelayMs` or
 * `retry.maxDelayMs`.
 */
export function assertRetryBounds(
  policy: Pick<RetryPolicy, 'maxAttempts' | 'baseDelayMs' | 'maxDelayMs'>,
): void {
  if (policy.maxAttempts !== undefined) {
    assertInteger(policy.maxAttempts, 'retry.maxAttempts', { min: 1, max: MAX_RETRY_ATTEMPTS });
  }
  if (policy.baseDelayMs !== undefined) {
    assertInteger(policy.baseDelayMs, 'retry.baseDelayMs', { min: 1, max: MAX_RETRY_DELAY_MS });
  }
  if (policy.maxDelayMs !== undefined) {
    assertInteger(policy.maxDelayMs, 'retry.maxDelayMs', {
      min: policy.baseDelayMs ?? 1,
      max: MAX_RETRY_DELAY_MS,
    });
  }
}

/**
 * Validate a retry policy: shape, then each bound.
 *
 * Accepts: `policy` — must be an object naming only `maxAttempts`,
 * `baseDelayMs` and `maxDelayMs`; each, if given, is a bounded integer.
 *
 * Returns: nothing: the value is kept under its declared type, and this
 * checks it.
 *
 * Throws: `VALIDATION` naming `retry` or `retry.<key>`.
 */
export function assertRetryPolicy(policy: RetryPolicy): void {
  assertShape(policy, RETRY_KEYS, 'retry');
  assertRetryBounds(policy);
}

/** The recency index: a named GSI, and the partition count rows are sharded across. */
function assertRecencyIndex(options: BaseAdapterOptions): void {
  if (options.indexShards !== undefined) {
    assertInteger(options.indexShards, 'indexShards', { min: 1, max: MAX_INDEX_SHARDS });
  }
  if (options.indexName !== undefined) assertNonEmptyString(options.indexName, 'indexName');
}

/**
 * Validate the options every adapter shares, at construction.
 *
 * Accepts: `options` — must be an object. `tableName` is required; every other
 * option is optional, and `undefined` means "not configured" for each. A
 * nested `ttl`, `retry`, `compression` or `s3` must be an object whose keys
 * this package reads: a misspelt key is rejected rather than ignored, because
 * the caller would otherwise run on a default they believe they overrode.
 * `clientConfig` and `s3.clientConfig` must be objects, but their keys belong
 * to the AWS SDK and are not checked. Keys of `options` itself are not checked
 * here — the adapter types differ and this validator sees only the shared ones.
 *
 * Returns: nothing: the value is kept under its declared type, and this
 * checks it.
 *
 * Throws: `VALIDATION` whose `context.field` names the offending option,
 * dotted for a nested one (`s3.bucketName`). The order is `tableName`, client
 * choice, `ttl`, `retry`, `compression`, `s3`, `readConcurrency`, then the
 * index options.
 *
 * Guarantees: a misconfiguration surfaces at construction, naming the option,
 * rather than as a raw AWS error on the first request.
 */
export function assertBaseAdapterOptions(options: BaseAdapterOptions & CodecOptions): void {
  if (typeof options !== 'object' || options === null) {
    throw validationError('options must be an object naming at least a tableName', 'options');
  }
  assertTableName(options.tableName);
  assertClientChoice(options);
  if (options.ttl !== undefined) resolveTtlSeconds(options.ttl);
  if (options.retry !== undefined) assertRetryPolicy(options.retry);
  if (options.compression !== undefined) assertCompression(options.compression);
  if (options.s3 !== undefined) assertS3(options.s3);
  if (options.readConcurrency !== undefined) {
    assertInteger(options.readConcurrency, 'readConcurrency', {
      min: 1,
      max: MAX_READ_CONCURRENCY,
    });
  }
  assertRecencyIndex(options);
}

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
 * Returns: nothing: the value is kept under its declared type, and this
 * checks it.
 *
 * Throws: `VALIDATION` naming the offending field, dotted under
 * `compression`.
 */
export function assertCompression(config: CompressionConfig): void {
  assertShape(config, COMPRESSION_KEYS, 'compression');
  if (typeof config.enabled !== 'boolean') {
    throw validationError('compression.enabled must be a boolean', 'compression.enabled');
  }
  if (config.level !== undefined) {
    assertInteger(config.level, 'compression.level', { min: 0, max: 9 });
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
    assertInteger(config.minSizeBytes, 'compression.minSizeBytes', {
      min: 0,
      max: MAX_PAYLOAD_BUFFER_BYTES,
    });
  }
  if (config.maxDecompressedBytes !== undefined) {
    assertInteger(config.maxDecompressedBytes, 'compression.maxDecompressedBytes', {
      min: 1,
      max: MAX_PAYLOAD_BUFFER_BYTES,
    });
  }
}

/**
 * Validate the two `s3` options `PutObject` receives as they were given.
 *
 * Accepts: `config.serverSideEncryption` — absent, or an algorithm S3 accepts.
 * `config.sseKmsKeyId` — absent, or a non-empty string. Only its type is
 * checked; whether it names a real key, by id or by ARN, is for S3 to answer.
 *
 * Returns: nothing: the value is kept under its declared type, and this
 * checks it.
 *
 * Throws: `VALIDATION` naming `s3.serverSideEncryption` or
 * `s3.sseKmsKeyId`. Unchecked, a truthy key id that is not a string was
 * handed to `PutObject` at the first offload, and a falsy one (`''`, `null`,
 * `0`) was dropped, uploading without the key the caller named.
 */
function assertS3Encryption(config: S3OffloadConfig): void {
  if (
    config.serverSideEncryption !== undefined &&
    !SSE_ALGORITHMS.includes(config.serverSideEncryption)
  ) {
    throw validationError(
      `s3.serverSideEncryption must be one of ${SSE_ALGORITHMS.join(', ')}`,
      's3.serverSideEncryption',
    );
  }
  if (config.sseKmsKeyId !== undefined) {
    assertNonEmptyString(config.sseKmsKeyId, 's3.sseKmsKeyId');
  }
}

/**
 * Validate an `s3` offload config, honoring its allowed key set.
 *
 * Accepts: `config` — an object naming only {@link S3OffloadConfig}'s keys.
 * `config.clientConfig`, when given, must be an object that is neither `null`
 * nor an array; its own keys are not checked. `config.createS3Client`, when
 * given, must be a function.
 *
 * Returns: nothing: the value is kept under its declared type, and this
 * checks it.
 *
 * Throws: `VALIDATION` naming the offending field, dotted under `s3`.
 */
export function assertS3(config: S3OffloadConfig): void {
  assertShape(config, S3_KEYS, 's3');
  assertNonEmptyString(config.bucketName, 's3.bucketName');
  /**
   * The shape only, never the keys: they are the AWS SDK's `S3ClientConfig`,
   * which gains keys between SDK releases, and an application may install a
   * newer SDK than the one this package was compiled against, so a key list
   * compiled in here would refuse valid configuration.
   */
  if (config.clientConfig !== undefined) assertObjectShape(config.clientConfig, 's3.clientConfig');
  if (config.thresholdBytes !== undefined) {
    assertInteger(config.thresholdBytes, 's3.thresholdBytes', {
      min: 1,
      max: MAX_INLINE_PAYLOAD_BYTES,
    });
  }
  if (config.keyPrefix !== undefined) assertScopedKeyPrefix(config.keyPrefix);
  if (config.maxDownloadBytes !== undefined) {
    assertInteger(config.maxDownloadBytes, 's3.maxDownloadBytes', {
      min: 1,
      max: MAX_PAYLOAD_BUFFER_BYTES,
    });
  }
  assertS3Encryption(config);
  /**
   * Called to build the S3 client at the first offload, where a value that is
   * not a function threw a bare `TypeError`.
   */
  if (config.createS3Client !== undefined && typeof config.createS3Client !== 'function') {
    throw validationError('s3.createS3Client must be a function', 's3.createS3Client');
  }
}
