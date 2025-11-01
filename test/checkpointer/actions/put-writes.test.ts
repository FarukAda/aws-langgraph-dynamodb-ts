import { putWritesAction } from '../../../src/checkpointer/actions';
import { setupCheckpointerTest, type CheckpointerTestSetup } from '../../shared/helpers/test-setup';
import { expectDynamoDBCalled } from '../../shared/helpers/assertions';
import { createMockPendingWrite, createMockRunnableConfig } from '../../shared/fixtures/test-data';

describe('putWritesAction', () => {
  let setup: CheckpointerTestSetup;

  beforeEach(() => {
    setup = setupCheckpointerTest();
  });

  afterEach(() => {
    setup.cleanup();
  });

  it('should save writes successfully', async () => {
    setup.ddbDocMock.onAnyCommand().resolvesOnce({});

    const writes = [
      createMockPendingWrite('channel1', { data: 'value1' }),
      createMockPendingWrite('channel2', { data: 'value2' }),
    ];

    await putWritesAction({
      client: setup.client,
      writesTableName: 'writes',
      serde: setup.serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
      writes,
      taskId: 'task-789',
    });

    expectDynamoDBCalled(setup.ddbDocMock, 1);
    expect(setup.serde.dumpsTyped).toHaveBeenCalledTimes(2);
  });

  it('should save writes with TTL', async () => {
    setup.ddbDocMock.onAnyCommand().resolvesOnce({});

    const writes = [createMockPendingWrite('channel1', { data: 'value1' })];

    await putWritesAction({
      client: setup.client,
      writesTableName: 'writes',
      serde: setup.serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
      writes,
      taskId: 'task-789',
      ttlDays: 30,
    });

    expectDynamoDBCalled(setup.ddbDocMock, 1);
  });

  it('should handle multiple writes in batches of 25', async () => {
    setup.ddbDocMock.onAnyCommand().resolves({});

    const writes = Array(60)
      .fill(null)
      .map((_, i) => createMockPendingWrite(`channel${i}`, { data: `value${i}` }));

    await putWritesAction({
      client: setup.client,
      writesTableName: 'writes',
      serde: setup.serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
      writes,
      taskId: 'task-789',
    });

    // Should have 3 batch writes: 25 + 25 + 10
    expectDynamoDBCalled(setup.ddbDocMock, 3);
  });

  describe('validation errors', () => {
    const singleWrite = [createMockPendingWrite('channel1', { data: 'value1' })];

    it.each([
      {
        description: 'missing checkpoint_id',
        params: {
          config: createMockRunnableConfig('thread-123', undefined, 'ns'),
          writes: singleWrite,
          taskId: 'task-789',
        },
        expectedError: 'Missing checkpoint_id',
      },
      {
        description: 'empty task_id',
        params: {
          config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
          writes: singleWrite,
          taskId: '',
        },
        expectedError: 'task_id cannot be empty',
      },
      {
        description: 'task_id with separator',
        params: {
          config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
          writes: singleWrite,
          taskId: 'task:::123',
        },
        expectedError: 'task_id cannot contain separator',
      },
      {
        description: 'invalid TTL days',
        params: {
          config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
          writes: singleWrite,
          taskId: 'task-789',
          ttlDays: 0,
        },
        expectedError: 'TTL days must be positive',
      },
      {
        description: 'empty thread_id',
        params: {
          config: { configurable: { thread_id: '', checkpoint_id: 'checkpoint-456' } },
          writes: singleWrite,
          taskId: 'task-789',
        },
        expectedError: 'thread_id cannot be empty',
      },
    ])('should throw error for $description', async ({ params, expectedError }) => {
      await expect(
        putWritesAction({
          client: setup.client,
          writesTableName: 'writes',
          serde: setup.serde,
          ...params,
        }),
      ).rejects.toThrow(expectedError);
    });

    it('should validate writes count exceeding maximum', async () => {
      const writes = Array(1001)
        .fill(null)
        .map((_, i) => createMockPendingWrite(`channel${i}`, { data: `value${i}` }));

      await expect(
        putWritesAction({
          client: setup.client,
          writesTableName: 'writes',
          serde: setup.serde,
          config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
          writes,
          taskId: 'task-789',
        }),
      ).rejects.toThrow('Writes count');
    });
  });

  it('should handle empty writes array', async () => {
    await putWritesAction({
      client: setup.client,
      writesTableName: 'writes',
      serde: setup.serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
      writes: [],
      taskId: 'task-789',
    });

    // No batch writes should be called for an empty array
    expectDynamoDBCalled(setup.ddbDocMock, 0);
  });

  it('should serialize each write value', async () => {
    setup.ddbDocMock.onAnyCommand().resolvesOnce({});

    const writes = [
      createMockPendingWrite('channel1', { data: 'value1' }),
      createMockPendingWrite('channel2', { data: 'value2' }),
      createMockPendingWrite('channel3', { data: 'value3' }),
    ];

    await putWritesAction({
      client: setup.client,
      writesTableName: 'writes',
      serde: setup.serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
      writes,
      taskId: 'task-789',
    });

    expect(setup.serde.dumpsTyped).toHaveBeenCalledTimes(3);
  });

  it('should handle DynamoDB errors with retry', async () => {
    // First attempt fails, second succeeds
    const error = new Error('Throttling error');
    error.name = 'ThrottlingException';
    setup.ddbDocMock.onAnyCommand().rejectsOnce(error);
    setup.ddbDocMock.onAnyCommand().resolves({});

    const writes = [createMockPendingWrite('channel1', { data: 'value1' })];

    await putWritesAction({
      client: setup.client,
      writesTableName: 'writes',
      serde: setup.serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
      writes,
      taskId: 'task-789',
    });

    expectDynamoDBCalled(setup.ddbDocMock, 2);
  });

  it('should handle exactly 25 writes in single batch', async () => {
    setup.ddbDocMock.onAnyCommand().resolvesOnce({});

    const writes = Array(25)
      .fill(null)
      .map((_, i) => createMockPendingWrite(`channel${i}`, { data: `value${i}` }));

    await putWritesAction({
      client: setup.client,
      writesTableName: 'writes',
      serde: setup.serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
      writes,
      taskId: 'task-789',
    });

    expectDynamoDBCalled(setup.ddbDocMock, 1);
  });

  it('should handle 26 writes in two batches', async () => {
    setup.ddbDocMock.onAnyCommand().resolves({});

    const writes = Array(26)
      .fill(null)
      .map((_, i) => createMockPendingWrite(`channel${i}`, { data: `value${i}` }));

    await putWritesAction({
      client: setup.client,
      writesTableName: 'writes',
      serde: setup.serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
      writes,
      taskId: 'task-789',
    });

    expectDynamoDBCalled(setup.ddbDocMock, 2);
  });

  it('should create correct idx for each write', async () => {
    setup.ddbDocMock.onAnyCommand().resolvesOnce({});

    const writes = [
      createMockPendingWrite('channel1', { data: 'value1' }),
      createMockPendingWrite('channel2', { data: 'value2' }),
    ];

    await putWritesAction({
      client: setup.client,
      writesTableName: 'writes',
      serde: setup.serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
      writes,
      taskId: 'task-789',
    });

    expectDynamoDBCalled(setup.ddbDocMock, 1);
  });

  it('should handle checkpoint_ns as empty string', async () => {
    setup.ddbDocMock.onAnyCommand().resolvesOnce({});

    const writes = [createMockPendingWrite('channel1', { data: 'value1' })];

    await putWritesAction({
      client: setup.client,
      writesTableName: 'writes',
      serde: setup.serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', ''),
      writes,
      taskId: 'task-789',
    });

    expectDynamoDBCalled(setup.ddbDocMock, 1);
  });
});
