import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

import { DynamoDBSaver } from '../../src';
import {
  createMockCheckpoint,
  createMockMetadata,
  createMockPendingWrite,
  createMockCheckpointItem,
} from '../shared/fixtures/test-data';

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

    it('should accept an injected DynamoDBDocument client', () => {
      const docClient = DynamoDBDocument.from(new DynamoDBClient({}));

      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
        client: docClient,
      });

      expect(saver).toBeInstanceOf(DynamoDBSaver);
      // destroy should NOT throw — it skips DDB client cleanup for injected clients
      saver.destroy();
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

    it('should paginate through multiple pages via LastEvaluatedKey', async () => {
      const page1Checkpoints = [createMockCheckpointItem('thread-123', 'checkpoint-1', 'ns')];
      const page2Checkpoints = [createMockCheckpointItem('thread-123', 'checkpoint-2', 'ns')];

      // First query returns page 1 with a LastEvaluatedKey
      ddbDocMock
        .onAnyCommand()
        .resolvesOnce({
          Items: page1Checkpoints,
          LastEvaluatedKey: { thread_id: 'thread-123', sort_key: 'checkpoint-1' },
        })
        // Second query returns page 2 with no LastEvaluatedKey
        .resolvesOnce({
          Items: page2Checkpoints,
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
      expect(results[1].config.configurable?.checkpoint_id).toBe('checkpoint-2');
      // Should have made 2 query calls (one per page)
      expect(ddbDocMock.calls()).toHaveLength(2);
    });

    it('should stop paginating when limit is reached across pages', async () => {
      const page1Checkpoints = [createMockCheckpointItem('thread-123', 'checkpoint-1', 'ns')];

      // First query returns 1 item with a LastEvaluatedKey
      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: page1Checkpoints,
        LastEvaluatedKey: { thread_id: 'thread-123', sort_key: 'checkpoint-1' },
      });

      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
      });

      const results = [];
      for await (const item of saver.list(
        { configurable: { thread_id: 'thread-123' } },
        { limit: 1 },
      )) {
        results.push(item);
      }

      // Should stop at limit=1 even though there are more pages
      expect(results).toHaveLength(1);
      // Should only have made 1 query call (stopped before fetching page 2)
      expect(ddbDocMock.calls()).toHaveLength(1);
    });

    it('should filter checkpoints by metadata source', async () => {
      // Create checkpoint items with different metadata sources
      const inputCheckpoint = {
        ...createMockCheckpointItem('thread-123', 'checkpoint-1', ''),
        metadata: new Uint8Array(Buffer.from(JSON.stringify(createMockMetadata('input')))),
      };
      const loopCheckpoint = {
        ...createMockCheckpointItem('thread-123', 'checkpoint-2', ''),
        metadata: new Uint8Array(Buffer.from(JSON.stringify(createMockMetadata('loop')))),
      };

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [inputCheckpoint, loopCheckpoint],
        LastEvaluatedKey: undefined,
      });

      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
      });

      const results = [];
      for await (const item of saver.list(
        { configurable: { thread_id: 'thread-123' } },
        { filter: { source: 'input' } },
      )) {
        results.push(item);
      }

      expect(results).toHaveLength(1);
      expect(results[0].metadata?.source).toBe('input');
    });

    it('should return no checkpoints when filter matches nothing', async () => {
      const checkpoints = [createMockCheckpointItem('thread-123', 'checkpoint-1', '')];

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
        { filter: { source: 'nonexistent' } },
      )) {
        results.push(item);
      }

      expect(results).toHaveLength(0);
    });

    it('should apply both filter and limit correctly', async () => {
      // Create 3 "input" checkpoints and 1 "loop" checkpoint
      const items = [
        {
          ...createMockCheckpointItem('thread-123', 'checkpoint-1', ''),
          metadata: new Uint8Array(Buffer.from(JSON.stringify(createMockMetadata('input')))),
        },
        {
          ...createMockCheckpointItem('thread-123', 'checkpoint-2', ''),
          metadata: new Uint8Array(Buffer.from(JSON.stringify(createMockMetadata('loop')))),
        },
        {
          ...createMockCheckpointItem('thread-123', 'checkpoint-3', ''),
          metadata: new Uint8Array(Buffer.from(JSON.stringify(createMockMetadata('input')))),
        },
        {
          ...createMockCheckpointItem('thread-123', 'checkpoint-4', ''),
          metadata: new Uint8Array(Buffer.from(JSON.stringify(createMockMetadata('input')))),
        },
      ];

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: items,
        LastEvaluatedKey: undefined,
      });

      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
      });

      const results = [];
      for await (const item of saver.list(
        { configurable: { thread_id: 'thread-123' } },
        { filter: { source: 'input' }, limit: 2 },
      )) {
        results.push(item);
      }

      // Should return 2 "input" checkpoints (limit=2), skipping the "loop" one
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.metadata?.source === 'input')).toBe(true);
    });
  });
});
