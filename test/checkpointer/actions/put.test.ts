import { putAction } from '../../../src/checkpointer/actions';
import { createMockDynamoDBClient } from '../../shared/mocks/dynamodb-mock';
import {
  createMockCheckpoint,
  createMockMetadata,
  createMockRunnableConfig,
  createMockSerde,
} from '../../shared/fixtures/test-data';
import { AwsStub } from 'aws-sdk-client-mock';
import {
  DynamoDBDocument,
  DynamoDBDocumentClientResolvedConfig,
  ServiceInputTypes,
  ServiceOutputTypes,
} from '@aws-sdk/lib-dynamodb';

describe('putAction', () => {
  let ddbDocMock: AwsStub<
    ServiceInputTypes,
    ServiceOutputTypes,
    DynamoDBDocumentClientResolvedConfig
  >;
  let client: DynamoDBDocument;
  let serde: any;

  beforeEach(() => {
    const mockClients = createMockDynamoDBClient();
    ddbDocMock = mockClients.ddbDocMock;
    client = mockClients.client;
    serde = createMockSerde();
  });

  afterEach(() => {
    ddbDocMock.reset();
  });

  it('should save checkpoint successfully', async () => {
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

    expect(ddbDocMock.calls()).toHaveLength(1);
  });

  it('should validate TTL days', async () => {
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
