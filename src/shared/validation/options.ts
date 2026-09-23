import {
  MAX_INDEX_SHARDS,
  MAX_READ_CONCURRENCY,
  MAX_RETRY_ATTEMPTS,
  MAX_RETRY_DELAY_MS,
} from '../constants';
import type { RetryPolicy } from '../dynamodb/retry-policy';
import { validationError } from '../errors/errors';
import type { BaseAdapterOptions, CodecOptions } from '../options';
import { validateCompression, validateS3 } from './codec-options';
import { allKeysOf, assertObjectShape, assertShape } from './option-shape';
import { validateInteger, validateNonEmptyString } from './primitives';
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
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: `VALIDATION` naming `tableName`.
 */
export function validateTableName(tableName: string): void {
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
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: `VALIDATION` naming `client` for both ways at once, then
 * `clientConfig` for one that is not an object.
 */
export function validateClientChoice(
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
 * validateRetryPolicy}'s narrower `assertShape`, which would refuse those
 * extra keys outright.
 *
 * Accepts: `policy` — its `maxAttempts`, `baseDelayMs` and `maxDelayMs`, each
 * optional.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: `VALIDATION` naming `retry.maxAttempts`, `retry.baseDelayMs` or
 * `retry.maxDelayMs`.
 */
export function validateRetryBounds(
  policy: Pick<RetryPolicy, 'maxAttempts' | 'baseDelayMs' | 'maxDelayMs'>,
): void {
  if (policy.maxAttempts !== undefined) {
    validateInteger(policy.maxAttempts, 'retry.maxAttempts', { min: 1, max: MAX_RETRY_ATTEMPTS });
  }
  if (policy.baseDelayMs !== undefined) {
    validateInteger(policy.baseDelayMs, 'retry.baseDelayMs', { min: 1, max: MAX_RETRY_DELAY_MS });
  }
  if (policy.maxDelayMs !== undefined) {
    validateInteger(policy.maxDelayMs, 'retry.maxDelayMs', {
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
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: `VALIDATION` naming `retry` or `retry.<key>`.
 */
export function validateRetryPolicy(policy: RetryPolicy): void {
  assertShape(policy, RETRY_KEYS, 'retry');
  validateRetryBounds(policy);
}

/** The recency index: a named GSI, and the partition count rows are sharded across. */
function validateRecencyIndex(options: BaseAdapterOptions): void {
  if (options.indexShards !== undefined) {
    validateInteger(options.indexShards, 'indexShards', { min: 1, max: MAX_INDEX_SHARDS });
  }
  if (options.indexName !== undefined) validateNonEmptyString(options.indexName, 'indexName');
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
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: `VALIDATION` whose `context.field` names the offending option,
 * dotted for a nested one (`s3.bucketName`). The order is `tableName`, client
 * choice, `ttl`, `retry`, `compression`, `s3`, `readConcurrency`, then the
 * index options.
 *
 * Guarantees: a misconfiguration surfaces at construction, naming the option,
 * rather than as a raw AWS error on the first request.
 */
export function validateBaseAdapterOptions(options: BaseAdapterOptions & CodecOptions): void {
  if (typeof options !== 'object' || options === null) {
    throw validationError('options must be an object naming at least a tableName', 'options');
  }
  validateTableName(options.tableName);
  validateClientChoice(options);
  if (options.ttl !== undefined) resolveTtlSeconds(options.ttl);
  if (options.retry !== undefined) validateRetryPolicy(options.retry);
  if (options.compression !== undefined) validateCompression(options.compression);
  if (options.s3 !== undefined) validateS3(options.s3);
  if (options.readConcurrency !== undefined) {
    validateInteger(options.readConcurrency, 'readConcurrency', {
      min: 1,
      max: MAX_READ_CONCURRENCY,
    });
  }
  validateRecencyIndex(options);
}
