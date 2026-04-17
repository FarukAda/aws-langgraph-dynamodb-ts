import type { CheckpointItem } from '../../../src/checkpointer/types';
import { deserializeCheckpointTuple } from '../../../src/checkpointer/utils/deserialization';
import { createMockSerde } from '../../shared/fixtures/test-data';

describe('deserializeCheckpointTuple', () => {
  const serde = createMockSerde();

  function baseItem(overrides: Partial<CheckpointItem> = {}): CheckpointItem {
    return {
      thread_id: 'thread-1',
      checkpoint_ns: '',
      checkpoint_id: 'ckpt-1',
      type: 'json',
      metadata: new Uint8Array(Buffer.from(JSON.stringify({ source: 'input', step: 0 }))),
      ...overrides,
    };
  }

  it('throws when checkpoint references S3 but no offloader is configured', async () => {
    const item = baseItem({ s3_checkpoint_key: 'prefix/thread-1/ckpt-1/checkpoint.bin' });

    await expect(
      deserializeCheckpointTuple(item, new Uint8Array(0), serde, undefined, undefined),
    ).rejects.toThrow(/no S3 offloader is configured/);
  });

  it('throws when metadata references S3 but no offloader is configured', async () => {
    const item = baseItem({ s3_metadata_key: 'prefix/thread-1/ckpt-1/metadata.bin' });

    await expect(
      deserializeCheckpointTuple(item, new Uint8Array(0), serde, undefined, undefined),
    ).rejects.toThrow(/no S3 offloader is configured/);
  });
});
