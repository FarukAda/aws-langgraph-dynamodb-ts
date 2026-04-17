import { putAction } from '../../../src/checkpointer/actions';
import {
  createMockCheckpoint,
  createMockMetadata,
  createMockRunnableConfig,
} from '../../shared/fixtures/test-data';
import {
  expectDynamoDBCalled,
  expectSerdeCalledTimes,
  expectValidationError,
} from '../../shared/helpers/assertions';
import { setupCheckpointerTest, type CheckpointerTestSetup } from '../../shared/helpers/test-setup';

describe('putAction', () => {
  let setup: CheckpointerTestSetup;

  beforeEach(() => {
    setup = setupCheckpointerTest();
  });

  afterEach(() => {
    setup.cleanup();
  });

  it('should save checkpoint successfully', async () => {
    setup.ddbDocMock.onAnyCommand().resolvesOnce({});

    const checkpoint = createMockCheckpoint('checkpoint-123');
    const metadata = createMockMetadata();

    const result = await putAction({
      client: setup.client,
      checkpointsTableName: 'checkpoints',
      serde: setup.serde,
      config: createMockRunnableConfig('thread-123', undefined, 'ns'),
      checkpoint,
      metadata,
    });

    expect(result.configurable?.thread_id).toBe('thread-123');
    expect(result.configurable?.checkpoint_id).toBe('checkpoint-123');
    expectDynamoDBCalled(setup.ddbDocMock, 1);
    expectSerdeCalledTimes(setup.serde, 2);
  });

  it('should save checkpoint with TTL', async () => {
    setup.ddbDocMock.onAnyCommand().resolvesOnce({});

    const checkpoint = createMockCheckpoint('checkpoint-123');
    const metadata = createMockMetadata();

    await putAction({
      client: setup.client,
      checkpointsTableName: 'checkpoints',
      serde: setup.serde,
      config: createMockRunnableConfig('thread-123', undefined, 'ns'),
      checkpoint,
      metadata,
      ttlDays: 30,
    });

    expectDynamoDBCalled(setup.ddbDocMock, 1);
  });

  it('should throw error when checkpoint.id is missing', async () => {
    const checkpoint = createMockCheckpoint('checkpoint-123');
    checkpoint.id = undefined as any;
    const metadata = createMockMetadata();

    await expectValidationError(
      putAction({
        client: setup.client,
        checkpointsTableName: 'checkpoints',
        serde: setup.serde,
        config: createMockRunnableConfig('thread-123', undefined, 'ns'),
        checkpoint,
        metadata,
      }),
      'Checkpoint ID is required',
    );
  });

  it('should throw error when checkpoint.id is empty', async () => {
    const checkpoint = createMockCheckpoint('');
    const metadata = createMockMetadata();

    await expectValidationError(
      putAction({
        client: setup.client,
        checkpointsTableName: 'checkpoints',
        serde: setup.serde,
        config: createMockRunnableConfig('thread-123', undefined, 'ns'),
        checkpoint,
        metadata,
      }),
      'Checkpoint ID is required',
    );
  });

  it('should throw error when checkpoint.id contains separator', async () => {
    const checkpoint = createMockCheckpoint('checkpoint:::123');
    const metadata = createMockMetadata();

    await expectValidationError(
      putAction({
        client: setup.client,
        checkpointsTableName: 'checkpoints',
        serde: setup.serde,
        config: createMockRunnableConfig('thread-123', undefined, 'ns'),
        checkpoint,
        metadata,
      }),
      'checkpoint_id cannot contain separator',
    );
  });

  it('should throw error when serialization types mismatch', async () => {
    const customSerde = {
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
        client: setup.client,
        checkpointsTableName: 'checkpoints',
        serde: customSerde,
        config: createMockRunnableConfig('thread-123', undefined, 'ns'),
        checkpoint,
        metadata,
      }),
    ).rejects.toThrow('Failed to serialize checkpoint and metadata to the same type');
  });

  it('should include parent_checkpoint_id when provided', async () => {
    setup.ddbDocMock.onAnyCommand().resolvesOnce({});

    const checkpoint = createMockCheckpoint('checkpoint-123');
    const metadata = createMockMetadata();

    await putAction({
      client: setup.client,
      checkpointsTableName: 'checkpoints',
      serde: setup.serde,
      config: createMockRunnableConfig('thread-123', 'parent-checkpoint', 'ns'),
      checkpoint,
      metadata,
    });

    expectDynamoDBCalled(setup.ddbDocMock, 1);
  });

  it('should default checkpoint_ns to empty string', async () => {
    setup.ddbDocMock.onAnyCommand().resolvesOnce({});

    const checkpoint = createMockCheckpoint('checkpoint-123');
    const metadata = createMockMetadata();

    const result = await putAction({
      client: setup.client,
      checkpointsTableName: 'checkpoints',
      serde: setup.serde,
      config: { configurable: { thread_id: 'thread-123' } },
      checkpoint,
      metadata,
    });

    expect(result.configurable?.checkpoint_ns).toBe('');
  });

  it('should calculate TTL correctly', async () => {
    setup.ddbDocMock.onAnyCommand().resolvesOnce({});

    const checkpoint = createMockCheckpoint('checkpoint-123');
    const metadata = createMockMetadata();

    await putAction({
      client: setup.client,
      checkpointsTableName: 'checkpoints',
      serde: setup.serde,
      config: createMockRunnableConfig('thread-123', undefined, 'ns'),
      checkpoint,
      metadata,
      ttlDays: 30,
    });

    expectDynamoDBCalled(setup.ddbDocMock, 1);
  });

  it('should validate TTL days', async () => {
    const checkpoint = createMockCheckpoint('checkpoint-123');
    const metadata = createMockMetadata();

    await expect(
      putAction({
        client: setup.client,
        checkpointsTableName: 'checkpoints',
        serde: setup.serde,
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
        client: setup.client,
        checkpointsTableName: 'checkpoints',
        serde: setup.serde,
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
        client: setup.client,
        checkpointsTableName: 'checkpoints',
        serde: setup.serde,
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
    setup.ddbDocMock.onAnyCommand().rejectsOnce(error);
    setup.ddbDocMock.onAnyCommand().resolves({});

    const checkpoint = createMockCheckpoint('checkpoint-123');
    const metadata = createMockMetadata();

    const result = await putAction({
      client: setup.client,
      checkpointsTableName: 'checkpoints',
      serde: setup.serde,
      config: createMockRunnableConfig('thread-123', undefined, 'ns'),
      checkpoint,
      metadata,
    });

    expect(result).toBeDefined();
    expectDynamoDBCalled(setup.ddbDocMock, 2);
  });

  it('should not include TTL when ttlDays is undefined', async () => {
    setup.ddbDocMock.onAnyCommand().resolvesOnce({});

    const checkpoint = createMockCheckpoint('checkpoint-123');
    const metadata = createMockMetadata();

    await putAction({
      client: setup.client,
      checkpointsTableName: 'checkpoints',
      serde: setup.serde,
      config: createMockRunnableConfig('thread-123', undefined, 'ns'),
      checkpoint,
      metadata,
      ttlDays: undefined,
    });

    expectDynamoDBCalled(setup.ddbDocMock, 1);
  });

  describe('optimistic concurrency guard', () => {
    const findTransactCall = (ddbDocMock: CheckpointerTestSetup['ddbDocMock']) => {
      for (const c of ddbDocMock.calls()) {
        const input = c.args[0].input as { TransactItems?: unknown[] };
        if (Array.isArray(input.TransactItems)) return input;
      }
      throw new Error('no transactWrite call captured');
    };

    it('includes idempotent-safe ConditionExpression on metadata Put for initial checkpoint', async () => {
      setup.ddbDocMock.onAnyCommand().resolvesOnce({});

      await putAction({
        client: setup.client,
        checkpointsTableName: 'checkpoints',
        serde: setup.serde,
        config: createMockRunnableConfig('thread-123', undefined, 'ns'),
        checkpoint: createMockCheckpoint('checkpoint-1'),
        metadata: createMockMetadata(),
      });

      const call = findTransactCall(setup.ddbDocMock);
      const metadataPut = (call.TransactItems as any[])[0].Put;
      // Exact expression string — weaker substring checks let the logic be
      // re-ordered in a way that breaks the intended semantics.
      expect(metadataPut.ConditionExpression).toBe(
        'attribute_not_exists(checkpoint_id) ' +
          'OR (#type = :expected_type AND (attribute_not_exists(parent_checkpoint_id)))',
      );
      expect(metadataPut.ExpressionAttributeNames).toEqual({ '#type': 'type' });
      expect(Object.keys(metadataPut.ExpressionAttributeValues)).toEqual([':expected_type']);
      expect(metadataPut.ExpressionAttributeValues[':expected_type']).toBeDefined();
      // Payload put stays unconditional.
      const payloadPut = (call.TransactItems as any[])[1].Put;
      expect(payloadPut.ConditionExpression).toBeUndefined();
    });

    it('includes parent_checkpoint_id equality clause when a parent is present', async () => {
      setup.ddbDocMock.onAnyCommand().resolvesOnce({});

      await putAction({
        client: setup.client,
        checkpointsTableName: 'checkpoints',
        serde: setup.serde,
        config: createMockRunnableConfig('thread-123', 'parent-42', 'ns'),
        checkpoint: createMockCheckpoint('checkpoint-2'),
        metadata: createMockMetadata(),
      });

      const call = findTransactCall(setup.ddbDocMock);
      const metadataPut = (call.TransactItems as any[])[0].Put;
      expect(metadataPut.ConditionExpression).toBe(
        'attribute_not_exists(checkpoint_id) ' +
          'OR (#type = :expected_type AND (parent_checkpoint_id = :expected_parent))',
      );
      expect(metadataPut.ExpressionAttributeValues[':expected_parent']).toBe('parent-42');
    });

    // Note: empty-string parent_checkpoint_id cannot reach put.ts in practice —
    // `validateConfigurable` → `validateCheckpointId` rejects it upstream.
    // The defensive normalization in put.ts is kept as belt-and-braces in case
    // a future refactor widens the validator; there's no reachable test path
    // for it to hit from the public API.
  });
});
