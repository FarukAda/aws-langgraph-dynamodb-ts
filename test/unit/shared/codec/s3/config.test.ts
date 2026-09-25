import { buildLifecycleRuleId, buildS3Key } from '../../../../../src/shared/codec/s3/config';
import { ErrorCode } from '../../../../../src/shared/errors/error-code';

/** A write's object id, shaped like the ULIDs this package draws. */
const ID = '01J9ZQ5X3N8VQ4M6C2T7R0K1HD';
const UUID = '3f1c0f9e-6a2b-4c1d-9e8f-7a6b5c4d3e2f';
const encode = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');

describe('buildS3Key', () => {
  it('base64url-encodes each part and ends in the object id, under the prefix', () => {
    expect(buildS3Key('langgraph/', ['thread1', 'ckpt1', 'checkpoint'], ID)).toBe(
      `langgraph/${encode('thread1')}/${encode('ckpt1')}/${encode('checkpoint')}/${ID}.bin`,
    );
  });

  /**
   * The id is appended as it is. The ids this package draws, a ULID for the
   * checkpointer and history and a UUID for the store, are already key-safe
   * and hold no `/`, so they cannot be read as a part.
   */
  it('appends a ULID or a UUID object id as the final segment without encoding it', () => {
    expect(buildS3Key('p/', ['row'], ID)).toBe(`p/${encode('row')}/${ID}.bin`);
    expect(buildS3Key('p/', ['row'], UUID)).toBe(`p/${encode('row')}/${UUID}.bin`);
  });

  /** Row identity sits above the id, so two rows written by one call get two objects. */
  it('gives two rows their own object under one object id', () => {
    expect(buildS3Key('p/', ['rowA'], ID)).not.toBe(buildS3Key('p/', ['rowB'], ID));
  });

  /** Two calls writing one row draw two ids, so they never address one object. */
  it('gives one row a different object for every object id', () => {
    expect(buildS3Key('p/', ['row'], ID)).not.toBe(buildS3Key('p/', ['row'], UUID));
  });

  it('composes the same key for the same prefix, parts and object id', () => {
    expect(buildS3Key('p/', ['row'], ID)).toBe(buildS3Key('p/', ['row'], ID));
  });

  it('never collides two different part arrays that would join to the same raw string', () => {
    expect(buildS3Key('p/', ['a/b', 'c'], ID)).not.toBe(buildS3Key('p/', ['a', 'b/c'], ID));
  });

  it('never collides on separator characters other than "/" either', () => {
    expect(buildS3Key('p/', ['a#b', 'c'], ID)).not.toBe(buildS3Key('p/', ['a', 'b', 'c'], ID));
  });
});

describe('buildS3Key row identity', () => {
  /**
   * Without a row above it, an object lies outside every row's scope and no
   * reader would accept it — so it could be written and never read back.
   */
  it('refuses to build a key with no row identity', () => {
    expect(() => buildS3Key('p/', [], ID)).toThrow(
      expect.objectContaining({
        code: ErrorCode.VALIDATION,
        context: { field: 's3Key' },
        message: expect.stringContaining('row that points at it'),
      }),
    );
  });
});

describe('buildS3Key length cap', () => {
  /** 600 raw bytes base64url-encode to 800 characters; one part fits, two overflow. */
  const part = 'x'.repeat(600);

  it('accepts a produced key within the 1024-byte S3 limit', () => {
    expect(() => buildS3Key('p/', [part], ID)).not.toThrow();
  });

  it('rejects a produced key over the 1024-byte S3 limit with a typed error', () => {
    expect(() => buildS3Key('p/', [part, part], ID)).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION }),
    );
    expect(() => buildS3Key('p/', [part, part], ID)).toThrow(
      expect.objectContaining({
        code: ErrorCode.VALIDATION,
        context: { field: 's3Key' },
        message: expect.stringMatching(/1634 bytes.*1024/),
      }),
    );
  });
});

describe('buildLifecycleRuleId', () => {
  it('slugifies the prefix into a stable, ttl-independent id', () => {
    expect(buildLifecycleRuleId('langgraph-checkpoints/')).toBe(
      'langgraph-ttl-langgraph-checkpoints',
    );
  });

  it('falls back to "default" when the prefix has no usable characters', () => {
    expect(buildLifecycleRuleId('/')).toBe('langgraph-ttl-default');
  });
});

describe('buildLifecycleRuleId trailing slashes', () => {
  it('strips every trailing slash without a quadratic regex, however many there are', () => {
    expect(buildLifecycleRuleId('langgraph/checkpointer///')).toBe(
      'langgraph-ttl-langgraph-checkpointer',
    );
    const started = Date.now();
    expect(buildLifecycleRuleId(`${'/'.repeat(50_000)}a`)).toBe(
      'langgraph-ttl-' + '-'.repeat(50_000) + 'a',
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
