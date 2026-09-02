import { MAX_INLINE_PAYLOAD_BYTES } from '../../../../src/shared/constants';
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
});
