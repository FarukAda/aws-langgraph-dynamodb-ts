import { buildLifecycleRuleId, buildS3Key } from '../../../../../src/shared/codec/s3/config';
import { ValidationError } from '../../../../../src/shared/errors/errors';

/** A stand-in content address: 43 base64url characters, like a real SHA-256. */
const HASH = 'A'.repeat(43);
const encode = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');

describe('buildS3Key', () => {
  it('base64url-encodes each part before joining under the prefix', () => {
    expect(buildS3Key('langgraph/', ['thread1', 'ckpt1', 'checkpoint'], HASH)).toBe(
      `langgraph/${encode('thread1')}/${encode('ckpt1')}/${encode('checkpoint')}/${HASH}.bin`,
    );
  });

  /**
   * The hash is already base64url, so it is appended verbatim. Encoding it
   * again would cost 15 characters of the 1024-byte key budget and make the
   * key unreadable against the digest it names.
   */
  it('appends the content hash as the final segment without re-encoding it', () => {
    const key = buildS3Key('p/', ['row'], HASH);
    expect(key.endsWith(`/${HASH}.bin`)).toBe(true);
  });

  /**
   * Row identity sits above the hash, so two rows holding identical bytes get
   * two objects — which is what lets a row delete its own object without
   * consulting any other row.
   */
  it('gives two rows their own object for identical content', () => {
    expect(buildS3Key('p/', ['rowA'], HASH)).not.toBe(buildS3Key('p/', ['rowB'], HASH));
  });

  it('gives one row one object for identical content, however often it is written', () => {
    expect(buildS3Key('p/', ['row'], HASH)).toBe(buildS3Key('p/', ['row'], HASH));
  });

  it('never collides two different part arrays that would join to the same raw string', () => {
    expect(buildS3Key('p/', ['a/b', 'c'], HASH)).not.toBe(buildS3Key('p/', ['a', 'b/c'], HASH));
  });

  it('never collides on separator characters other than "/" either', () => {
    expect(buildS3Key('p/', ['a#b', 'c'], HASH)).not.toBe(buildS3Key('p/', ['a', 'b', 'c'], HASH));
  });
});

describe('buildS3Key row identity', () => {
  /**
   * Without a row above it, an object lies outside every row's scope and no
   * reader would accept it — so it could be written and never read back.
   */
  it('refuses to build a key with no row identity', () => {
    expect(() => buildS3Key('p/', [], HASH)).toThrow(/row that points at it/);
  });
});

describe('buildS3Key length cap (CODEC-11)', () => {
  /** 600 raw bytes base64url-encode to 800 characters; one part fits, two overflow. */
  const part = 'x'.repeat(600);

  it('accepts a produced key within the 1024-byte S3 limit', () => {
    expect(() => buildS3Key('p/', [part], HASH)).not.toThrow();
  });

  it('rejects a produced key over the 1024-byte S3 limit with a typed error', () => {
    expect(() => buildS3Key('p/', [part, part], HASH)).toThrow(ValidationError);
    expect(() => buildS3Key('p/', [part, part], HASH)).toThrow(/1651 bytes.*1024/);
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

describe('buildLifecycleRuleId trailing slashes (SEC-17)', () => {
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
