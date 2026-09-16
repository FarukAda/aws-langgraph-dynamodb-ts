import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { validateCompression, validateS3 } from '../../../../src/shared/validation/codec-options';

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
 * Direct unit coverage of the module extracted from `options.ts` to stay under
 * its 150-line cap; `validateBaseAdapterOptions`'s own tests exercise every
 * branch through the composed entry point, this exercises the unit itself.
 */
describe('validateCompression', () => {
  it('accepts a minimal valid configuration', () => {
    expect(() => validateCompression({ enabled: true })).not.toThrow();
  });

  it('rejects a non-boolean enabled flag', () => {
    expectValidationError(
      () => validateCompression({ enabled: 'yes' as never }),
      'compression.enabled',
    );
  });
});

describe('validateS3', () => {
  it('accepts a minimal valid configuration', () => {
    expect(() => validateS3({ bucketName: 'b' })).not.toThrow();
  });

  it('rejects an empty bucket name', () => {
    expectValidationError(() => validateS3({ bucketName: '' }), 's3.bucketName');
  });
});
