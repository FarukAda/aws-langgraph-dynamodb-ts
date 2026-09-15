import { contentHash } from '../../../../../src/shared/codec/content-hash';
import { oversizedObjectError } from '../../../../../src/shared/codec/s3/bounded-body';
import { s3ClientOptions } from '../../../../../src/shared/codec/s3/client-types';
import {
  assertScopedKeyPrefix,
  defaultAdapterKeyPrefix,
} from '../../../../../src/shared/codec/s3/config';
import { encodeKeyPart } from '../../../../../src/shared/codec/s3/key-scope';
import { ErrorCode } from '../../../../../src/shared/errors/error-code';

describe('contentHash', () => {
  const bytes = new TextEncoder().encode('hello');

  it('is stable for the same bytes and different for different bytes', () => {
    expect(contentHash(bytes)).toBe(contentHash(new TextEncoder().encode('hello')));
    expect(contentHash(bytes)).not.toBe(contentHash(new TextEncoder().encode('hellp')));
  });

  /** 43 base64url characters, every one of them safe in an object key. */
  it('is 43 characters from the key-safe alphabet', () => {
    expect(contentHash(bytes)).toHaveLength(43);
    expect(contentHash(bytes)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hashes empty bytes rather than refusing them', () => {
    expect(contentHash(new Uint8Array())).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('oversizedObjectError', () => {
  const error = oversizedObjectError('ckpt/t/x.bin', 2_000, 1_000);

  it('carries the offload code, the operation and the key', () => {
    expect(error.code).toBe(ErrorCode.S3_OFFLOAD_FAILED);
    expect(error.context).toMatchObject({ operation: 'download', key: 'ckpt/t/x.bin' });
  });

  it('quotes both sizes, so the cap to raise is obvious', () => {
    expect(error.message).toContain('1000');
    expect(error.message).toContain('2000');
  });
});

describe('s3ClientOptions', () => {
  it('reads the options of a config through the structural type', () => {
    expect(s3ClientOptions({ region: 'eu-west-1' }).region).toBe('eu-west-1');
  });

  /** An absent config reads as empty rather than needing a guard at every call site. */
  it('answers empty for an absent config', () => {
    expect(s3ClientOptions(undefined)).toEqual({});
  });
});

describe('defaultAdapterKeyPrefix', () => {
  it('gives each adapter its own path under one bucket prefix', () => {
    expect(defaultAdapterKeyPrefix('payloads/', 'store')).toBe('payloads/store/');
    expect(defaultAdapterKeyPrefix('payloads/', 'checkpointer')).toBe('payloads/checkpointer/');
    expect(defaultAdapterKeyPrefix('payloads/', 'history')).toBe('payloads/history/');
  });
});

describe('assertScopedKeyPrefix', () => {
  it('accepts a prefix that ends at a path boundary', () => {
    expect(() => assertScopedKeyPrefix('payloads/store/')).not.toThrow();
  });

  /**
   * Without the trailing separator one adapter's prefix is a string prefix of
   * another's, and a key-scope check would let one read the other's objects.
   */
  it('refuses a prefix that does not end at one', () => {
    try {
      assertScopedKeyPrefix('payloads/store');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { context: { field?: string } }).context.field).toBe('s3.keyPrefix');
    }
  });
});

describe('encodeKeyPart', () => {
  it('encodes a part into an alphabet that never contains the path separator', () => {
    expect(encodeKeyPart('a/b')).not.toContain('/');
    expect(encodeKeyPart('a/b')).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  /** Two distinct parts can never compose one path, whatever characters they hold. */
  it('maps distinct parts to distinct encodings', () => {
    expect(encodeKeyPart('ab')).not.toBe(encodeKeyPart('a/b'));
    expect(encodeKeyPart('a')).not.toBe(encodeKeyPart('b'));
    expect(encodeKeyPart('')).toBe('');
  });
});
