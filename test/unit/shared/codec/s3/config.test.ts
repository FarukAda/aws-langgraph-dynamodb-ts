import { buildLifecycleRuleId, buildS3Key } from '../../../../../src/shared/codec/s3/config';

describe('buildS3Key', () => {
  it('joins parts under the prefix with a .bin suffix', () => {
    expect(buildS3Key('langgraph/', ['thread1', 'ckpt1', 'checkpoint'])).toBe(
      'langgraph/thread1/ckpt1/checkpoint.bin',
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
