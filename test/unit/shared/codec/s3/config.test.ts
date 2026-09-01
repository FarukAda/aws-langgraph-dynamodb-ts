import { buildLifecycleRuleId, buildS3Key } from '../../../../../src/shared/codec/s3/config';
import { ValidationError } from '../../../../../src/shared/errors/errors';

describe('buildS3Key', () => {
  it('base64url-encodes each part before joining under the prefix', () => {
    const encode = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
    expect(buildS3Key('langgraph/', ['thread1', 'ckpt1', 'checkpoint'])).toBe(
      `langgraph/${encode('thread1')}/${encode('ckpt1')}/${encode('checkpoint')}.bin`,
    );
  });

  it('never collides two different part arrays that would join to the same raw string', () => {
    const keyA = buildS3Key('p/', ['a/b', 'c']);
    const keyB = buildS3Key('p/', ['a', 'b/c']);
    expect(keyA).not.toBe(keyB);
  });

  it('never collides on separator characters other than "/" either', () => {
    const keyA = buildS3Key('p/', ['a#b', 'c']);
    const keyB = buildS3Key('p/', ['a', 'b', 'c']);
    expect(keyA).not.toBe(keyB);
  });
});

describe('buildS3Key length cap (CODEC-11)', () => {
  // 600 raw bytes base64url-encode to 800 characters; one part fits, two overflow.
  const part = 'x'.repeat(600);

  it('accepts a produced key within the 1024-byte S3 limit', () => {
    expect(() => buildS3Key('p/', [part])).not.toThrow();
  });

  it('rejects a produced key over the 1024-byte S3 limit with a typed error', () => {
    expect(() => buildS3Key('p/', [part, part])).toThrow(ValidationError);
    expect(() => buildS3Key('p/', [part, part])).toThrow(/1607 bytes.*1024/);
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
