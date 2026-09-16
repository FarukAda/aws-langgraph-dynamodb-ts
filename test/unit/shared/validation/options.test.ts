import {
  MAX_INDEX_SHARDS,
  MAX_INLINE_PAYLOAD_BYTES,
  MAX_PAYLOAD_BUFFER_BYTES,
  MAX_READ_CONCURRENCY,
  MAX_RETRY_DELAY_MS,
} from '../../../../src/shared/constants';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import type { BaseAdapterOptions, CodecOptions } from '../../../../src/shared/options';
import { validateBaseAdapterOptions } from '../../../../src/shared/validation/options';

type Options = BaseAdapterOptions & CodecOptions;

const client = { send: jest.fn() } as never;
const base: Options = { tableName: 'langgraph', client };

function expectValidationError(fn: () => void, field: string): void {
  try {
    fn();
    throw new Error('should have thrown');
  } catch (error) {
    const coded = error as { code?: ErrorCode; context?: { field?: string } };
    expect(coded.code).toBe(ErrorCode.VALIDATION);
    expect(coded.context?.field).toBe(field);
  }
}

/** Rejects `ceiling + 1` naming `field`, accepts `ceiling`: proves a named `max:` bound is live. */
function expectCeiling(build: (value: number) => Options, field: string, ceiling: number): void {
  expectValidationError(() => validateBaseAdapterOptions(build(ceiling + 1)), field);
  expect(() => validateBaseAdapterOptions(build(ceiling))).not.toThrow();
}

describe('validateBaseAdapterOptions', () => {
  describe('tableName', () => {
    it.each(['', 'ab', 'a'.repeat(256), 'bad name', 'tab/le', 'täble', 42 as never])(
      "rejects %j with DynamoDB's naming rule",
      (tableName) => {
        expectValidationError(() => validateBaseAdapterOptions({ tableName, client }), 'tableName');
      },
    );

    it('accepts DynamoDB-legal names', () => {
      for (const tableName of ['abc', 'lang-graph_v1.0', 'A'.repeat(255)]) {
        expect(() => validateBaseAdapterOptions({ tableName, client })).not.toThrow();
      }
    });
  });

  describe('client configuration', () => {
    it('rejects an injected client together with clientConfig or createClient', () => {
      expectValidationError(
        () => validateBaseAdapterOptions({ ...base, clientConfig: { region: 'eu-central-1' } }),
        'client',
      );
      expectValidationError(
        () => validateBaseAdapterOptions({ ...base, createClient: () => client }),
        'client',
      );
    });

    it('accepts a client alone, a clientConfig alone, or neither', () => {
      expect(() => validateBaseAdapterOptions(base)).not.toThrow();
      expect(() =>
        validateBaseAdapterOptions({
          tableName: 'langgraph',
          clientConfig: { region: 'eu-central-1' },
        }),
      ).not.toThrow();
      expect(() => validateBaseAdapterOptions({ tableName: 'langgraph' })).not.toThrow();
    });
  });

  describe('ttl', () => {
    it('is validated eagerly instead of on the first write', () => {
      expectValidationError(
        () => validateBaseAdapterOptions({ ...base, ttl: { days: 0 } }),
        'ttl.days',
      );
    });
  });

  describe('retry', () => {
    it('rejects each malformed tunable by name', () => {
      expectValidationError(
        () => validateBaseAdapterOptions({ ...base, retry: { maxAttempts: 0 } }),
        'retry.maxAttempts',
      );
      expectValidationError(
        () => validateBaseAdapterOptions({ ...base, retry: { maxAttempts: 101 } }),
        'retry.maxAttempts',
      );
      expectValidationError(
        () => validateBaseAdapterOptions({ ...base, retry: { baseDelayMs: 0 } }),
        'retry.baseDelayMs',
      );
      expectValidationError(
        () => validateBaseAdapterOptions({ ...base, retry: { baseDelayMs: 500, maxDelayMs: 100 } }),
        'retry.maxDelayMs',
      );
    });

    it('bounds maxDelayMs on its own when no baseDelayMs is given', () => {
      expectValidationError(
        () => validateBaseAdapterOptions({ ...base, retry: { maxDelayMs: 0 } }),
        'retry.maxDelayMs',
      );
      expect(() =>
        validateBaseAdapterOptions({ ...base, retry: { maxDelayMs: 10 } }),
      ).not.toThrow();
    });

    /** An unbounded delay turns a retry loop into a de facto hang. */
    it('bounds baseDelayMs and maxDelayMs at MAX_RETRY_DELAY_MS', () => {
      expectCeiling(
        (v) => ({ ...base, retry: { baseDelayMs: v } }),
        'retry.baseDelayMs',
        MAX_RETRY_DELAY_MS,
      );
      expectCeiling(
        (v) => ({ ...base, retry: { maxDelayMs: v } }),
        'retry.maxDelayMs',
        MAX_RETRY_DELAY_MS,
      );
    });

    it('accepts a complete valid policy', () => {
      expect(() =>
        validateBaseAdapterOptions({
          ...base,
          retry: { maxAttempts: 10, baseDelayMs: 50, maxDelayMs: 2000 },
        }),
      ).not.toThrow();
    });
  });

  describe('compression', () => {
    it('rejects each malformed field by name', () => {
      expectValidationError(
        () => validateBaseAdapterOptions({ ...base, compression: { enabled: 'yes' as never } }),
        'compression.enabled',
      );
      expectValidationError(
        () => validateBaseAdapterOptions({ ...base, compression: { enabled: true, level: 10 } }),
        'compression.level',
      );
      expectValidationError(
        () =>
          validateBaseAdapterOptions({ ...base, compression: { enabled: true, minSizeBytes: -1 } }),
        'compression.minSizeBytes',
      );
      expectValidationError(
        () =>
          validateBaseAdapterOptions({
            ...base,
            compression: { enabled: true, maxDecompressedBytes: 0 },
          }),
        'compression.maxDecompressedBytes',
      );
    });

    it('accepts a complete valid configuration', () => {
      expect(() =>
        validateBaseAdapterOptions({
          ...base,
          compression: { enabled: false, level: 0, minSizeBytes: 0, maxDecompressedBytes: 1 },
        }),
      ).not.toThrow();
    });

    /**
     * Both bound at MAX_PAYLOAD_BUFFER_BYTES, not MAX_INLINE_PAYLOAD_BYTES:
     * compression runs before the inline/offload decision, so a threshold
     * above the inline cap is still meaningful with `s3` configured (below).
     */
    it('bounds minSizeBytes and maxDecompressedBytes at MAX_PAYLOAD_BUFFER_BYTES', () => {
      expectCeiling(
        (v) => ({ ...base, compression: { enabled: true, minSizeBytes: v } }),
        'compression.minSizeBytes',
        MAX_PAYLOAD_BUFFER_BYTES,
      );
      expectCeiling(
        (v) => ({ ...base, compression: { enabled: true, maxDecompressedBytes: v } }),
        'compression.maxDecompressedBytes',
        MAX_PAYLOAD_BUFFER_BYTES,
      );
    });

    /**
     * Regression: `minSizeBytes` above the inline cap ("compress only what
     * will be offloaded anyway") must stay valid once `s3` is configured —
     * caught by review after P2.2 first shipped this bound at
     * MAX_INLINE_PAYLOAD_BYTES, which broke it.
     */
    it('accepts a minSizeBytes above the inline cap when s3 offload is configured', () => {
      expect(() =>
        validateBaseAdapterOptions({
          ...base,
          compression: { enabled: true, minSizeBytes: 500_000 },
          s3: { bucketName: 'b' },
        }),
      ).not.toThrow();
    });
  });

  describe('s3', () => {
    it('rejects an empty bucket name', () => {
      expectValidationError(
        () => validateBaseAdapterOptions({ ...base, s3: { bucketName: '' } }),
        's3.bucketName',
      );
    });

    it('rejects a threshold that cannot fit a DynamoDB item', () => {
      for (const thresholdBytes of [0, MAX_INLINE_PAYLOAD_BYTES + 1, 1.5]) {
        expectValidationError(
          () => validateBaseAdapterOptions({ ...base, s3: { bucketName: 'b', thresholdBytes } }),
          's3.thresholdBytes',
        );
      }
    });

    it('rejects an empty, root, or slash-less key prefix (a lifecycle rule would be bucket-wide or match siblings)', () => {
      for (const keyPrefix of ['', '/', 'app/langgraph']) {
        expectValidationError(
          () => validateBaseAdapterOptions({ ...base, s3: { bucketName: 'b', keyPrefix } }),
          's3.keyPrefix',
        );
      }
    });

    it('rejects a non-positive or fractional maxDownloadBytes', () => {
      for (const maxDownloadBytes of [0, 1.5]) {
        expectValidationError(
          () => validateBaseAdapterOptions({ ...base, s3: { bucketName: 'b', maxDownloadBytes } }),
          's3.maxDownloadBytes',
        );
      }
    });

    /** A single buffered download above the named ceiling risks an OOM on a modest process. */
    it('bounds maxDownloadBytes at MAX_PAYLOAD_BUFFER_BYTES', () => {
      expectCeiling(
        (v) => ({ ...base, s3: { bucketName: 'b', maxDownloadBytes: v } }),
        's3.maxDownloadBytes',
        MAX_PAYLOAD_BUFFER_BYTES,
      );
    });

    it('rejects an unknown server-side encryption algorithm', () => {
      expectValidationError(
        () =>
          validateBaseAdapterOptions({
            ...base,
            s3: { bucketName: 'b', serverSideEncryption: 'rot13' },
          }),
        's3.serverSideEncryption',
      );
    });

    it('accepts a complete valid configuration', () => {
      expect(() =>
        validateBaseAdapterOptions({
          ...base,
          s3: {
            bucketName: 'b',
            thresholdBytes: 1024,
            keyPrefix: 'app/langgraph/',
            serverSideEncryption: 'aws:kms',
            sseKmsKeyId: 'key-id',
          },
        }),
      ).not.toThrow();
    });
  });
  /**
   * The multiplier on the memory ceiling: one call holds up to
   * `readConcurrency` payloads, each with its downloaded and its decompressed
   * form resident. A zero would stall every read, a fraction is meaningless.
   */
  /**
   * A key this package does not read is a misconfiguration, not an extension:
   * the caller overrode nothing and runs on the default. The allowed sets are
   * compile-checked against the option types, so they cannot drift.
   */
  describe('unknown and malformed nested options', () => {
    it.each([
      ['retry', { retry: { maxAttempt: 3 } }, 'retry.maxAttempt'],
      ['compression', { compression: { enabled: true, minSize: 10 } }, 'compression.minSize'],
      ['s3', { s3: { bucketName: 'b', bucket: 'b' } }, 's3.bucket'],
    ])('rejects a misspelt %s key by name', (_name, extra, field) => {
      expectValidationError(
        () => validateBaseAdapterOptions({ ...base, ...extra } as never),
        field,
      );
    });

    it.each([
      ['retry', { retry: 5 }, 'retry'],
      ['compression', { compression: 'on' }, 'compression'],
      ['s3', { s3: ['bucket'] }, 's3'],
    ])('rejects a %s that is not an object', (_name, extra, field) => {
      expectValidationError(
        () => validateBaseAdapterOptions({ ...base, ...extra } as never),
        field,
      );
    });

    it('accepts every key each nested option actually declares', () => {
      expect(() =>
        validateBaseAdapterOptions({
          ...base,
          retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 20 },
          compression: { enabled: true, level: 6, minSizeBytes: 10, maxDecompressedBytes: 1024 },
          s3: {
            bucketName: 'b',
            keyPrefix: 'p/',
            thresholdBytes: 1024,
            serverSideEncryption: 'AES256',
            sseKmsKeyId: 'k',
            maxDownloadBytes: 2048,
            clientConfig: {},
          },
        }),
      ).not.toThrow();
    });
  });

  describe('the options object itself', () => {
    it.each([undefined, null, 'table', 42] as never[])('rejects %p', (options) => {
      expectValidationError(() => validateBaseAdapterOptions(options), 'options');
    });
  });

  describe('readConcurrency', () => {
    it.each([0, -1, 1.5, '8' as never])('rejects %j', (readConcurrency) => {
      expectValidationError(
        () => validateBaseAdapterOptions({ ...base, readConcurrency }),
        'readConcurrency',
      );
    });

    it('accepts a positive integer', () => {
      expect(() => validateBaseAdapterOptions({ ...base, readConcurrency: 2 })).not.toThrow();
    });

    /** Unbounded concurrency multiplies the memory ceiling and floods the backend with requests. */
    it('bounds readConcurrency at MAX_READ_CONCURRENCY', () => {
      expectCeiling(
        (v) => ({ ...base, readConcurrency: v }),
        'readConcurrency',
        MAX_READ_CONCURRENCY,
      );
    });
  });

  /**
   * A shard count the writers and the readers disagree on puts rows on
   * partitions no listing queries, which looks exactly like the rows being
   * gone. It is rejected where it is written, not on the first read.
   */
  describe('the recency index', () => {
    it.each([0, -1, 1.5, '8' as never])('rejects indexShards %j', (indexShards) => {
      expectValidationError(
        () => validateBaseAdapterOptions({ ...base, indexShards }),
        'indexShards',
      );
    });

    it('rejects an empty indexName', () => {
      expectValidationError(
        () => validateBaseAdapterOptions({ ...base, indexName: '' }),
        'indexName',
      );
    });

    it('accepts a named index with an explicit shard count', () => {
      expect(() =>
        validateBaseAdapterOptions({ ...base, indexName: 'gsi1', indexShards: 4 }),
      ).not.toThrow();
    });

    /**
     * The read fans out one query per shard (audit H-08), so an unbounded
     * shard count turns a config typo into an unbounded request storm.
     */
    it('refuses an indexShards value that would fan out unboundedly, bounded at MAX_INDEX_SHARDS', () => {
      expectCeiling((v) => ({ ...base, indexShards: v }), 'indexShards', MAX_INDEX_SHARDS);
      expectValidationError(
        () => validateBaseAdapterOptions({ tableName: 'tbl', client, indexShards: 1e12 }),
        'indexShards',
      );
    });
  });
});
