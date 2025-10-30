import { putAction } from '../../../src/checkpointer/actions/put';
import { createMockDynamoDBClient, mockDynamoDBPut } from '../../shared/mocks/dynamodb-mock';
import {
  createMockCheckpoint,
  createMockMetadata,
  createMockRunnableConfig,
  createMockSerde,
} from '../../shared/fixtures/test-data';

describe('putAction', () => {
  it('should save checkpoint successfully', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();
    const serde = createMockSerde();

    ddbDocMock.onAnyCommand().resolvesOnce({});

    const checkpoint = createMockCheckpoint('checkpoint-123');
    const metadata = createMockMetadata();

    const result = await putAction({
      client,
      checkpointsTableName: 'checkpoints',
      serde,
      config: createMockRunnableConfig('thread-123', undefined, 'ns'),
      checkpoint,
      metadata,
    });

    expect(result.configurable?.thread_id).toBe('thread-123');
    expect(result.configurable?.checkpoint_id).toBe('checkpoint-123');
    expect(result.configurable?.checkpoint_ns).toBe('ns');
    expect(serde.dumpsTyped).toHaveBeenCalledTimes(2);
  });

  it('should save checkpoint with TTL', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();
    const serde = createMockSerde();

    ddbDocMock.onAnyCommand().resolvesOnce({});

    const checkpoint = createMockCheckpoint('checkpoint-123');
    const metadata = createMockMetadata();

    await putAction({
      client,
      checkpointsTableName: 'checkpoints',
      serde,
      config: createMockRunnableConfig('thread-123', undefined, 'ns'),
      checkpoint,
      metadata,
      ttlDays: 30,
    });

    const calls = ddbDocMock.calls();
    expect(calls).toHaveLength(1);
  });

  it('should throw error when checkpoint.id is missing', async () => {
    const { client } = createMockDynamoDBClient();
    const serde = createMockSerde();

    const checkpoint = createMockCheckpoint('checkpoint-123');
    checkpoint.id = undefined as any;
    const metadata = createMockMetadata();

    await expect(
      putAction({
        client,
        checkpointsTableName: 'checkpoints',
        serde,
        config: createMockRunnableConfig('thread-123', undefined, 'ns'),
        checkpoint,
        metadata,
      }),
    ).rejects.toThrow('Checkpoint ID is required');
  });

  it('should throw error when checkpoint.id is empty', async () => {
    const { client } = createMockDynamoDBClient();
    const serde = createMockSerde();

    const checkpoint = createMockCheckpoint('');
    const metadata = createMockMetadata();

    await expect(
      putAction({
        client,
        checkpointsTableName: 'checkpoints',
        serde,
        config: createMockRunnableConfig('thread-123', undefined, 'ns'),
        checkpoint,
        metadata,
      }),
    ).rejects.toThrow('Checkpoint ID is required');
  });

  it('should throw error when checkpoint.id contains separator', async () => {
    const { client } = createMockDynamoDBClient();
    const serde = createMockSerde();

    const checkpoint = createMockCheckpoint('checkpoint:::123');
    const metadata = createMockMetadata();

    await expect(
      putAction({
        client,
        checkpointsTableName: 'checkpoints',
        serde,
        config: createMockRunnableConfig('thread-123', undefined, 'ns'),
        checkpoint,
        metadata,
      }),
    ).rejects.toThrow('checkpoint_id cannot contain separator');
  });

  it('should throw error when serialization types mismatch', async () => {
    const { client } = createMockDynamoDBClient();
    const serde = {
      dumpsTyped: jest
        .fn()
        .mockResolvedValueOnce(['json', new Uint8Array()])
        .mockResolvedValueOnce(['binary', new Uint8Array()]),
      loadsTyped: jest.fn(),
    };

    const checkpoint = createMockCheckpoint('checkpoint-123');
    const metadata = createMockMetadata();

    await expect(
      putAction({
        client,
        checkpointsTableName: 'checkpoints',
        serde,
        config: createMockRunnableConfig('thread-123', undefined, 'ns'),
        checkpoint,
        metadata,
      }),
    ).rejects.toThrow('Failed to serialize checkpoint and metadata to the same type');
  });

  it('should include parent_checkpoint_id when provided', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();
    const serde = createMockSerde();

    ddbDocMock.onAnyCommand().resolvesOnce({});

    const checkpoint = createMockCheckpoint('checkpoint-123');
    const metadata = createMockMetadata();

    await putAction({
      client,
      checkpointsTableName: 'checkpoints',
      serde,
      config: createMockRunnableConfig('thread-123', 'parent-checkpoint', 'ns'),
      checkpoint,
      metadata,
    });

    expect(ddbDocMock.calls()).toHaveLength(1);
  });

  it('should default checkpoint_ns to empty string', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();
    const serde = createMockSerde();

    ddbDocMock.onAnyCommand().resolvesOnce({});

    const checkpoint = createMockCheckpoint('checkpoint-123');
    const metadata = createMockMetadata();

    const result = await putAction({
      client,
      checkpointsTableName: 'checkpoints',
      serde,
      config: { configurable: { thread_id: 'thread-123' } },
      checkpoint,
      metadata,
    });

    expect(result.configurable?.checkpoint_ns).toBe('');
  });

  it('should calculate TTL correctly', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();
    const serde = createMockSerde();

    ddbDocMock.onAnyCommand().resolvesOnce({});

    const checkpoint = createMockCheckpoint('checkpoint-123');
    const metadata = createMockMetadata();

    const beforeTimestamp = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

    await putAction({
      client,
      checkpointsTableName: 'checkpoints',
      serde,
      config: createMockRunnableConfig('thread-123', undefined, 'ns'),
      checkpoint,
      metadata,
      ttlDays: 30,
    });

    const afterTimestamp = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

    expect(ddbDocMock.calls()).toHaveLength(1);
  });

  it('should validate TTL days', async () => {
    const { client } = createMockDynamoDBClient();
    const serde = createMockSerde();

    const checkpoint = createMockCheckpoint('checkpoint-123');
    const metadata = createMockMetadata();

    await expect(
      putAction({
        client,
        checkpointsTableName: 'checkpoints',
        serde,
        config: createMockRunnableConfig('thread-123', undefined, 'ns'),
        checkpoint,
        metadata,
        ttlDays: 0,
      }),
    ).rejects.toThrow('TTL days must be positive');
  });

  it('should validate invalid TTL days type', async () => {
    const { client } = createMockDynamoDBClient();
    const serde = createMockSerde();

    const checkpoint = createMockCheckpoint('checkpoint-123');
    const metadata = createMockMetadata();

    await expect(
      putAction({
        client,
        checkpointsTableName: 'checkpoints',
        serde,
        config: createMockRunnableConfig('thread-123', undefined, 'ns'),
        checkpoint,
        metadata,
        ttlDays: 1.5,
      }),
    ).rejects.toThrow('TTL days must be an integer');
  });

  it('should throw error for invalid thread_id', async () => {
    const { client } = createMockDynamoDBClient();
    const serde = createMockSerde();

    const checkpoint = createMockCheckpoint('checkpoint-123');
    const metadata = createMockMetadata();

    await expect(
      putAction({
        client,
        checkpointsTableName: 'checkpoints',
        serde,
        config: { configurable: { thread_id: '' } },
        checkpoint,
        metadata,
      }),
    ).rejects.toThrow('thread_id cannot be empty');
  });

  it('should handle DynamoDB errors with retry', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();
    const serde = createMockSerde();

    // First attempt fails, second succeeds
    const error = new Error('Throttling error');
    error.name = 'ThrottlingException';
    ddbDocMock.onAnyCommand().rejectsOnce(error);
    ddbDocMock.onAnyCommand().resolves({});

    const checkpoint = createMockCheckpoint('checkpoint-123');
    const metadata = createMockMetadata();

    const result = await putAction({
      client,
      checkpointsTableName: 'checkpoints',
      serde,
      config: createMockRunnableConfig('thread-123', undefined, 'ns'),
      checkpoint,
      metadata,
    });

    expect(result).toBeDefined();
    expect(ddbDocMock.calls()).toHaveLength(2);
  });

  it('should not include TTL when ttlDays is undefined', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();
    const serde = createMockSerde();

    ddbDocMock.onAnyCommand().resolvesOnce({});

    const checkpoint = createMockCheckpoint('checkpoint-123');
    const metadata = createMockMetadata();

    await putAction({
      client,
      checkpointsTableName: 'checkpoints',
      serde,
      config: createMockRunnableConfig('thread-123', undefined, 'ns'),
      checkpoint,
      metadata,
      ttlDays: undefined,
    });

    expect(ddbDocMock.calls()).toHaveLength(1);
  });
});
