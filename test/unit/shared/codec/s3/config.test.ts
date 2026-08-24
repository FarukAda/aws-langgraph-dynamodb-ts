import { buildLifecycleRuleId, buildS3Key } from '../../../../../src/shared/codec/s3/config';

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
