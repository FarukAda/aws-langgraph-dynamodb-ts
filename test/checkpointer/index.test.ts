import { DynamoDBSaver } from '../../src/checkpointer';
import {
  createMockCheckpoint,
  createMockMetadata,
  createMockPendingWrite,
  createMockCheckpointItem,
} from '../shared/fixtures/test-data';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

describe('DynamoDBSaver', () => {
  let ddbDocMock: any;

  beforeEach(() => {
    ddbDocMock = mockClient(DynamoDBDocumentClient);
    ddbDocMock.reset();
  });

  describe('constructor', () => {
    it('should create instance with required options', () => {
      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
      });

      expect(saver).toBeInstanceOf(DynamoDBSaver);
    });

    it('should create instance with all options', () => {
      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
        ttlDays: 30,
        clientConfig: { region: 'us-east-1' },
      });

      expect(saver).toBeInstanceOf(DynamoDBSaver);
    });

    it('should create instance with custom serde', () => {
      const customSerde = {
        dumpsTyped: jest.fn(),
        loadsTyped: jest.fn(),
      };

      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
        serde: customSerde,
      });

      expect(saver).toBeInstanceOf(DynamoDBSaver);
    });
  });

  describe('deleteThread', () => {
    it('should call deleteThreadAction', async () => {
      ddbDocMock.onAnyCommand().resolves({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
      });

      await saver.deleteThread('thread-123');

      expect(ddbDocMock.calls()).toHaveLength(1);
    });

    it('should throw error for invalid thread_id', async () => {
      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
      });

      await expect(saver.deleteThread('')).rejects.toThrow('thread_id cannot be empty');
    });
  });

  describe('getTuple', () => {
    it('should call getTupleAction', async () => {
      const checkpointItem = createMockCheckpointItem('thread-123', 'checkpoint-456', 'ns');

      ddbDocMock.onAnyCommand().resolvesOnce({
        Item: checkpointItem,
      });
      ddbDocMock.onAnyCommand().resolves({
        Items: [],
      });

      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
      });

      const result = await saver.getTuple({
        configurable: {
          thread_id: 'thread-123',
          checkpoint_id: 'checkpoint-456',
          checkpoint_ns: 'ns',
        },
      });

      expect(result).toBeDefined();
      expect(result!.config.configurable?.thread_id).toBe('thread-123');
    });

    it('should return undefined when checkpoint not found', async () => {
      ddbDocMock.onAnyCommand().resolvesOnce({});

      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
      });

      const result = await saver.getTuple({
        configurable: {
          thread_id: 'thread-123',
          checkpoint_id: 'non-existent',
        },
      });

      expect(result).toBeUndefined();
    });
  });

  describe('put', () => {
    it('should call putAction', async () => {
      ddbDocMock.onAnyCommand().resolvesOnce({});

      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
      });

      const checkpoint = createMockCheckpoint('checkpoint-123');
      const metadata = createMockMetadata();

      const result = await saver.put(
        { configurable: { thread_id: 'thread-123' } },
        checkpoint,
        metadata,
        {},
      );

      expect(result.configurable?.thread_id).toBe('thread-123');
      expect(result.configurable?.checkpoint_id).toBe('checkpoint-123');
    });

    it('should pass ttlDays to putAction', async () => {
      ddbDocMock.onAnyCommand().resolvesOnce({});

      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
        ttlDays: 30,
      });

      const checkpoint = createMockCheckpoint('checkpoint-123');
      const metadata = createMockMetadata();

      await saver.put({ configurable: { thread_id: 'thread-123' } }, checkpoint, metadata, {});

      expect(ddbDocMock.calls()).toHaveLength(1);
    });
  });

  describe('putWrites', () => {
    it('should call putWritesAction', async () => {
      ddbDocMock.onAnyCommand().resolvesOnce({});

      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
      });

      const writes = [createMockPendingWrite('channel1', { data: 'value1' })];

      await saver.putWrites(
        { configurable: { thread_id: 'thread-123', checkpoint_id: 'checkpoint-456' } },
        writes,
        'task-789',
      );

      expect(ddbDocMock.calls()).toHaveLength(1);
    });

    it('should pass ttlDays to putWritesAction', async () => {
      ddbDocMock.onAnyCommand().resolvesOnce({});

      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
        ttlDays: 30,
      });

      const writes = [createMockPendingWrite('channel1', { data: 'value1' })];

      await saver.putWrites(
        { configurable: { thread_id: 'thread-123', checkpoint_id: 'checkpoint-456' } },
        writes,
        'task-789',
      );

      expect(ddbDocMock.calls()).toHaveLength(1);
    });
  });

  describe('list', () => {
    it('should list checkpoints', async () => {
      const checkpoints = [
        createMockCheckpointItem('thread-123', 'checkpoint-1', 'ns'),
        createMockCheckpointItem('thread-123', 'checkpoint-2', 'ns'),
      ];

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: checkpoints,
        LastEvaluatedKey: undefined,
      });

      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
      });

      const results = [];
      for await (const item of saver.list({ configurable: { thread_id: 'thread-123' } }, {})) {
        results.push(item);
      }

      expect(results).toHaveLength(2);
      expect(results[0].config.configurable?.checkpoint_id).toBe('checkpoint-1');
    });

    it('should list checkpoints with limit', async () => {
      const checkpoints = [createMockCheckpointItem('thread-123', 'checkpoint-1', 'ns')];

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: checkpoints,
        LastEvaluatedKey: undefined,
      });

      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
      });

      const results = [];
      for await (const item of saver.list(
        { configurable: { thread_id: 'thread-123' } },
        { limit: 10 },
      )) {
        results.push(item);
      }

      expect(results).toHaveLength(1);
    });

    it('should list checkpoints with before filter', async () => {
      const checkpoints = [createMockCheckpointItem('thread-123', 'checkpoint-1', 'ns')];

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: checkpoints,
        LastEvaluatedKey: undefined,
      });

      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
      });

      const results = [];
      for await (const item of saver.list(
        { configurable: { thread_id: 'thread-123' } },
        { before: { configurable: { checkpoint_id: 'checkpoint-5' } } },
      )) {
        results.push(item);
      }

      expect(results).toHaveLength(1);
    });

    it('should return empty list when no checkpoints', async () => {
      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
      });

      const results = [];
      for await (const item of saver.list({ configurable: { thread_id: 'thread-123' } }, {})) {
        results.push(item);
      }

      expect(results).toHaveLength(0);
    });

    it('should handle response with no Items field', async () => {
      ddbDocMock.onAnyCommand().resolvesOnce({
        LastEvaluatedKey: undefined,
      });

      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
      });

      const results = [];
      for await (const item of saver.list({ configurable: { thread_id: 'thread-123' } }, {})) {
        results.push(item);
      }

      expect(results).toHaveLength(0);
    });

    it('should throw error for invalid thread_id', async () => {
      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
      });

      const generator = saver.list({ configurable: { thread_id: 123 as any } }, {});

      await expect(generator.next()).rejects.toThrow('thread_id must be a string');
    });

    it('should throw error for missing thread_id', async () => {
      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
      });

      const generator = saver.list({ configurable: {} }, {});

      await expect(generator.next()).rejects.toThrow('thread_id must be a string');
    });

    it('should throw error for invalid limit', async () => {
      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
      });

      const generator = saver.list({ configurable: { thread_id: 'thread-123' } }, { limit: -1 });

      await expect(generator.next()).rejects.toThrow('Limit must be positive');
    });

    it('should include parent config when available', async () => {
      const checkpointWithParent = {
        ...createMockCheckpointItem('thread-123', 'checkpoint-1', 'ns'),
        parent_checkpoint_id: 'checkpoint-parent',
      };

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [checkpointWithParent],
        LastEvaluatedKey: undefined,
      });

      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
      });

      const results = [];
      for await (const item of saver.list({ configurable: { thread_id: 'thread-123' } }, {})) {
        results.push(item);
      }

      expect(results[0].parentConfig).toBeDefined();
      expect(results[0].parentConfig?.configurable?.checkpoint_id).toBe('checkpoint-parent');
    });

    it('should handle undefined options', async () => {
      const checkpoints = [createMockCheckpointItem('thread-123', 'checkpoint-1', 'ns')];

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: checkpoints,
        LastEvaluatedKey: undefined,
      });

      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
      });

      const results = [];
      for await (const item of saver.list(
        { configurable: { thread_id: 'thread-123' } },
        undefined,
      )) {
        results.push(item);
      }

      expect(results).toHaveLength(1);
    });
  });
});
