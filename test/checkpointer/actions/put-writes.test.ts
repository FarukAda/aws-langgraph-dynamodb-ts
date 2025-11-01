import { AwsStub } from 'aws-sdk-client-mock';
import {
  DynamoDBDocument,
  DynamoDBDocumentClientResolvedConfig,
  ServiceInputTypes,
  ServiceOutputTypes,
} from '@aws-sdk/lib-dynamodb';

import { putWritesAction } from '../../../src/checkpointer/actions';
import { createMockDynamoDBClient } from '../../shared/mocks/dynamodb-mock';
import {
  createMockPendingWrite,
  createMockRunnableConfig,
  createMockSerde,
} from '../../shared/fixtures/test-data';

describe('putWritesAction', () => {
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

  it('should save writes successfully', async () => {
    ddbDocMock.onAnyCommand().resolvesOnce({});

    const writes = [
      createMockPendingWrite('channel1', { data: 'value1' }),
      createMockPendingWrite('channel2', { data: 'value2' }),
    ];

    await putWritesAction({
      client,
      writesTableName: 'writes',
      serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
      writes,
      taskId: 'task-789',
    });

    expect(ddbDocMock.calls()).toHaveLength(1);
    expect(serde.dumpsTyped).toHaveBeenCalledTimes(2);
  });

  it('should save writes with TTL', async () => {
    ddbDocMock.onAnyCommand().resolvesOnce({});

    const writes = [createMockPendingWrite('channel1', { data: 'value1' })];

    await putWritesAction({
      client,
      writesTableName: 'writes',
      serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
      writes,
      taskId: 'task-789',
      ttlDays: 30,
    });

    expect(ddbDocMock.calls()).toHaveLength(1);
  });

  it('should handle multiple writes in batches of 25', async () => {
    ddbDocMock.onAnyCommand().resolves({});

    const writes = Array(60)
      .fill(null)
      .map((_, i) => createMockPendingWrite(`channel${i}`, { data: `value${i}` }));

    await putWritesAction({
      client,
      writesTableName: 'writes',
      serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
      writes,
      taskId: 'task-789',
    });

    // Should have 3 batch writes: 25 + 25 + 10
    expect(ddbDocMock.calls()).toHaveLength(3);
  });

  it('should throw error when checkpoint_id is missing', async () => {
    const writes = [createMockPendingWrite('channel1', { data: 'value1' })];

    await expect(
      putWritesAction({
        client,
        writesTableName: 'writes',
        serde,
        config: createMockRunnableConfig('thread-123', undefined, 'ns'),
        writes,
        taskId: 'task-789',
      }),
    ).rejects.toThrow('Missing checkpoint_id');
  });

  it('should validate writes count exceeding maximum', async () => {
    const writes = Array(1001)
      .fill(null)
      .map((_, i) => createMockPendingWrite(`channel${i}`, { data: `value${i}` }));

    await expect(
      putWritesAction({
        client,
        writesTableName: 'writes',
        serde,
        config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
        writes,
        taskId: 'task-789',
      }),
    ).rejects.toThrow('Writes count');
  });

  it('should handle empty writes array', async () => {
    await putWritesAction({
      client,
      writesTableName: 'writes',
      serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
      writes: [],
      taskId: 'task-789',
    });

    // No batch writes should be called for an empty array
    expect(ddbDocMock.calls()).toHaveLength(0);
  });

  it('should validate task_id', async () => {
    const writes = [createMockPendingWrite('channel1', { data: 'value1' })];

    await expect(
      putWritesAction({
        client,
        writesTableName: 'writes',
        serde,
        config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
        writes,
        taskId: '',
      }),
    ).rejects.toThrow('task_id cannot be empty');
  });

  it('should validate task_id with separator', async () => {
    const writes = [createMockPendingWrite('channel1', { data: 'value1' })];

    await expect(
      putWritesAction({
        client,
        writesTableName: 'writes',
        serde,
        config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
        writes,
        taskId: 'task:::123',
      }),
    ).rejects.toThrow('task_id cannot contain separator');
  });

  it('should validate TTL days', async () => {
    const writes = [createMockPendingWrite('channel1', { data: 'value1' })];

    await expect(
      putWritesAction({
        client,
        writesTableName: 'writes',
        serde,
        config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
        writes,
        taskId: 'task-789',
        ttlDays: 0,
      }),
    ).rejects.toThrow('TTL days must be positive');
  });

  it('should validate thread_id', async () => {
    const writes = [createMockPendingWrite('channel1', { data: 'value1' })];

    await expect(
      putWritesAction({
        client,
        writesTableName: 'writes',
        serde,
        config: { configurable: { thread_id: '', checkpoint_id: 'checkpoint-456' } },
        writes,
        taskId: 'task-789',
      }),
    ).rejects.toThrow('thread_id cannot be empty');
  });

  it('should serialize each write value', async () => {
    ddbDocMock.onAnyCommand().resolvesOnce({});

    const writes = [
      createMockPendingWrite('channel1', { data: 'value1' }),
      createMockPendingWrite('channel2', { data: 'value2' }),
      createMockPendingWrite('channel3', { data: 'value3' }),
    ];

    await putWritesAction({
      client,
      writesTableName: 'writes',
      serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
      writes,
      taskId: 'task-789',
    });

    expect(serde.dumpsTyped).toHaveBeenCalledTimes(3);
  });

  it('should handle DynamoDB errors with retry', async () => {
    // First attempt fails, second succeeds
    const error = new Error('Throttling error');
    error.name = 'ThrottlingException';
    ddbDocMock.onAnyCommand().rejectsOnce(error);
    ddbDocMock.onAnyCommand().resolves({});

    const writes = [createMockPendingWrite('channel1', { data: 'value1' })];

    await putWritesAction({
      client,
      writesTableName: 'writes',
      serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
      writes,
      taskId: 'task-789',
    });

    expect(ddbDocMock.calls()).toHaveLength(2);
  });

  it('should handle exactly 25 writes in single batch', async () => {
    ddbDocMock.onAnyCommand().resolvesOnce({});

    const writes = Array(25)
      .fill(null)
      .map((_, i) => createMockPendingWrite(`channel${i}`, { data: `value${i}` }));

    await putWritesAction({
      client,
      writesTableName: 'writes',
      serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
      writes,
      taskId: 'task-789',
    });

    expect(ddbDocMock.calls()).toHaveLength(1);
  });

  it('should handle 26 writes in two batches', async () => {
    ddbDocMock.onAnyCommand().resolves({});

    const writes = Array(26)
      .fill(null)
      .map((_, i) => createMockPendingWrite(`channel${i}`, { data: `value${i}` }));

    await putWritesAction({
      client,
      writesTableName: 'writes',
      serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
      writes,
      taskId: 'task-789',
    });

    expect(ddbDocMock.calls()).toHaveLength(2);
  });

  it('should create correct idx for each write', async () => {
    ddbDocMock.onAnyCommand().resolvesOnce({});

    const writes = [
      createMockPendingWrite('channel1', { data: 'value1' }),
      createMockPendingWrite('channel2', { data: 'value2' }),
    ];

    await putWritesAction({
      client,
      writesTableName: 'writes',
      serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
      writes,
      taskId: 'task-789',
    });

    expect(ddbDocMock.calls()).toHaveLength(1);
  });

  it('should handle checkpoint_ns as empty string', async () => {
    ddbDocMock.onAnyCommand().resolvesOnce({});

    const writes = [createMockPendingWrite('channel1', { data: 'value1' })];

    await putWritesAction({
      client,
      writesTableName: 'writes',
      serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', ''),
      writes,
      taskId: 'task-789',
    });

    expect(ddbDocMock.calls()).toHaveLength(1);
  });
});
