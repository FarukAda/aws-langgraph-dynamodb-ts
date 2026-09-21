import { oversizedObjectError } from '../../../../../src/shared/codec/s3/bounded-body';
import { s3ClientOptions } from '../../../../../src/shared/codec/s3/client-types';
import {
  assertScopedKeyPrefix,
  defaultAdapterKeyPrefix,
} from '../../../../../src/shared/codec/s3/config';
import { encodeKeyPart } from '../../../../../src/shared/codec/s3/key-scope';
import { ErrorCode } from '../../../../../src/shared/errors/error-code';

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
  function expectRefusal(keyPrefix: string): void {
    try {
      assertScopedKeyPrefix(keyPrefix);
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { context: { field?: string } }).context.field).toBe('s3.keyPrefix');
    }
  }

  it('accepts a prefix that ends at a path boundary', () => {
    expect(() => assertScopedKeyPrefix('payloads/store/')).not.toThrow();
    expect(() => assertScopedKeyPrefix('langgraph/')).not.toThrow();
    expect(() => assertScopedKeyPrefix('a/b/c/')).not.toThrow();
  });

  /**
   * Without the trailing separator one adapter's prefix is a string prefix of
   * another's, and a key-scope check would let one read the other's objects.
   */
  it('refuses a prefix that does not end at one', () => {
    expectRefusal('payloads/store');
  });

  /**
   * The prefix is what the IAM object-key condition and the lifecycle rule's
   * `Filter.Prefix` are both written against, and every tool that normalises a
   * path resolves `..` before matching either. A prefix carrying one therefore
   * names keys outside the scope the deployment granted and outside the scope
   * the lifecycle rule sweeps, which is the one thing a prefix exists to fix.
   */
  it.each(['../', './', 'a/../b/', 'a/./b/'])('refuses the traversal prefix %j', (keyPrefix) => {
    expectRefusal(keyPrefix);
  });

  /**
   * An S3 key is a byte string, not a path: `/a/b.bin` and `a/b.bin` are two
   * different objects, and a prefix with an empty segment addresses the one no
   * normalising tool — the console, a lifecycle filter written by hand, this
   * package's own scope check — agrees with.
   */
  it.each(['/a/', '//', 'a//b/'])('refuses the empty-segment prefix %j', (keyPrefix) => {
    expectRefusal(keyPrefix);
  });

  /** The same rule identifiers already meet: this prefix reaches log lines too. */
  it('refuses a prefix holding a control character or a lone surrogate', () => {
    expectRefusal('a\nb/');
    expectRefusal(`a${String.fromCharCode(0x1b)}b/`);
    expectRefusal(`a${String.fromCharCode(0xd800)}b/`);
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
