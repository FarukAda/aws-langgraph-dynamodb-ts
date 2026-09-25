import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { assertCompression, assertS3 } from '../../../../src/shared/validation/options';

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

/**
 * Direct unit coverage of the module extracted from `options.ts`;
 * `assertBaseAdapterOptions`'s own tests exercise every
 * branch through the composed entry point, this exercises the unit itself.
 */
describe('assertCompression', () => {
  it('accepts a minimal valid configuration', () => {
    expect(() => assertCompression({ enabled: true })).not.toThrow();
  });

  it('rejects a non-boolean enabled flag', () => {
    expectValidationError(
      () => assertCompression({ enabled: 'yes' as never }),
      'compression.enabled',
    );
  });
});

describe('assertS3', () => {
  it('accepts a minimal valid configuration', () => {
    expect(() => assertS3({ bucketName: 'b' })).not.toThrow();
  });

  it('rejects an empty bucket name', () => {
    expectValidationError(() => assertS3({ bucketName: '' }), 's3.bucketName');
  });
});
