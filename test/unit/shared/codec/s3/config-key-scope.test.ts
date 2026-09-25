import {
  buildS3Key,
  assertKeyInScope,
  isKeyInScope,
  s3KeyScope,
} from '../../../../../src/shared/codec/s3/config';
import { ErrorCode } from '../../../../../src/shared/errors/error-code';
import { MAX_LOGGED_VALUE_CHARS, truncateForLog } from '../../../../../src/shared/logging/truncate';

const enc = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');
const ID = '01J9ZQ5X3N8VQ4M6C2T7R0K1HD';

describe('s3KeyScope / isKeyInScope (SEC-03)', () => {
  it('names the path every key built from the parts shares', () => {
    expect(s3KeyScope('p/', ['t', 'ns'])).toBe(`p/${enc('t')}/${enc('ns')}`);
    expect(s3KeyScope('p/', [])).toBe('p/');
  });

  /**
   * A reader checks a row-sourced key against the row's *leading* parts, and
   * the write's object id is always one segment deeper, so this is the branch
   * every key this release writes takes.
   */
  it('accepts a key whose path continues below the scope', () => {
    const item = buildS3Key('p/', ['users', 'u1', 'k'], ID);
    expect(isKeyInScope(item, 'p/', ['users', 'u1', 'k'])).toBe(true);
    const checkpoint = buildS3Key('p/', ['t', '', 'c', 'checkpoint'], ID);
    expect(isKeyInScope(checkpoint, 'p/', ['t'])).toBe(true);
  });

  /**
   * A release that gave a store item's key no per-write segment wrote its
   * object at exactly `<scope>.bin`, with no segment below the row. Those
   * objects are still referenced by rows written then, so the equality branch
   * stays.
   */
  it('accepts a key that is exactly the scope, as earlier releases wrote it', () => {
    expect(isKeyInScope(`p/${enc('users')}/${enc('u1')}.bin`, 'p/', ['users', 'u1'])).toBe(true);
  });

  it('rejects another identifier, a sibling sharing a leading substring, and another prefix', () => {
    expect(isKeyInScope(buildS3Key('p/', ['t2', 'x'], ID), 'p/', ['t'])).toBe(false);
    expect(isKeyInScope(buildS3Key('p/', ['t1'], ID), 'p/', ['t'])).toBe(false);
    expect(isKeyInScope(buildS3Key('other/', ['t', 'x'], ID), 'p/', ['t'])).toBe(false);
    expect(isKeyInScope('unrelated/object.bin', 'p/', ['t'])).toBe(false);
  });

  it('degrades to a prefix-only check when no parts are given', () => {
    expect(isKeyInScope('p/anything.bin', 'p/', [])).toBe(true);
    expect(isKeyInScope('q/anything.bin', 'p/', [])).toBe(false);
  });
});

describe('assertKeyInScope', () => {
  it('throws a VALIDATION error naming the s3Key field and the allowed path', () => {
    expect(() => assertKeyInScope(buildS3Key('p/', ['t'], ID), 'p/', ['t'])).not.toThrow();
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

  /**
   * The same value, from the same row: cut at the cap for the `warn` that
   * reports an object outside the scope and quoted whole by the error that
   * refuses it. The key stays named — a bounded prefix still identifies the
   * object — and `context` keeps nothing, because this error carries the field
   * name alone, which is what a caller branches on.
   */
  it('bounds the row-sourced key and the path it quotes', () => {
    const key = `p/${'z'.repeat(MAX_LOGGED_VALUE_CHARS * 4)}.bin`;
    try {
      assertKeyInScope(key, 'p/', ['t']);
      throw new Error('should have thrown');
    } catch (error) {
      const coded = error as { context?: { field?: string }; message: string };
      expect(coded.context?.field).toBe('s3Key');
      expect(coded.message).toContain(truncateForLog(key));
      expect(coded.message).not.toContain(key);
      expect(coded.message.length).toBeLessThan(key.length);
    }
  });

  /**
   * `s3.keyPrefix` is checked for shape and never for length, so the path the
   * message names is no more bounded than the key it refuses.
   */
  it('bounds the scope when a long keyPrefix composed it', () => {
    const prefix = `${'q'.repeat(MAX_LOGGED_VALUE_CHARS * 4)}/`;
    const { message } = capture(() => assertKeyInScope('p/elsewhere.bin', prefix, ['t']));
    expect(message).toContain(truncateForLog(s3KeyScope(prefix, ['t'])));
    expect(message.length).toBeLessThan(prefix.length);
  });
});

function capture(fn: () => void): { message: string } {
  try {
    fn();
    throw new Error('should have thrown');
  } catch (error) {
    return { message: (error as Error).message };
  }
}
