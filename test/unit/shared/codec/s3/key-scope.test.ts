import { buildS3Key } from '../../../../../src/shared/codec/s3/config';
import {
  assertKeyInScope,
  isKeyInScope,
  s3KeyScope,
} from '../../../../../src/shared/codec/s3/key-scope';
import { ErrorCode } from '../../../../../src/shared/errors/error-code';

const enc = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');

describe('s3KeyScope / isKeyInScope (SEC-03)', () => {
  it('names the path every key built from the parts shares', () => {
    expect(s3KeyScope('p/', ['t', 'ns'])).toBe(`p/${enc('t')}/${enc('ns')}`);
    expect(s3KeyScope('p/', [])).toBe('p/');
  });

  it('accepts a key built from exactly the parts or from the parts plus more', () => {
    const exact = buildS3Key('p/', ['users', 'u1', 'k']);
    expect(isKeyInScope(exact, 'p/', ['users', 'u1', 'k'])).toBe(true);
    const nonced = buildS3Key('p/', ['users', 'u1', 'k', 'nonce']);
    expect(isKeyInScope(nonced, 'p/', ['users', 'u1', 'k'])).toBe(true);
    const checkpoint = buildS3Key('p/', ['t', '', 'c', 'checkpoint', 'n']);
    expect(isKeyInScope(checkpoint, 'p/', ['t'])).toBe(true);
  });

  it('rejects another identifier, a sibling sharing a leading substring, and another prefix', () => {
    expect(isKeyInScope(buildS3Key('p/', ['t2', 'x']), 'p/', ['t'])).toBe(false);
    expect(isKeyInScope(buildS3Key('p/', ['t1']), 'p/', ['t'])).toBe(false);
    expect(isKeyInScope(buildS3Key('other/', ['t', 'x']), 'p/', ['t'])).toBe(false);
    expect(isKeyInScope('unrelated/object.bin', 'p/', ['t'])).toBe(false);
  });

  it('degrades to a prefix-only check when no parts are given', () => {
    expect(isKeyInScope('p/anything.bin', 'p/', [])).toBe(true);
    expect(isKeyInScope('q/anything.bin', 'p/', [])).toBe(false);
  });
});

describe('assertKeyInScope', () => {
  it('throws a ValidationError naming the s3Key field and the allowed path', () => {
    expect(() => assertKeyInScope(buildS3Key('p/', ['t']), 'p/', ['t'])).not.toThrow();
    try {
      assertKeyInScope('p/elsewhere.bin', 'p/', ['t']);
      throw new Error('should have thrown');
    } catch (error) {
      const coded = error as { code?: string; context?: { field?: string }; message: string };
      expect(coded.code).toBe(ErrorCode.VALIDATION);
      expect(coded.context?.field).toBe('s3Key');
      expect(coded.message).toContain(`p/${enc('t')}`);
    }
  });
});
