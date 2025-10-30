import { DynamoDBStore } from '../../src/store';
import { createMockEmbedding } from '../shared/mocks/embedding-mock';
import { createMockStoreItem } from '../shared/fixtures/test-data';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

describe('DynamoDBStore', () => {
  let ddbDocMock: any;

  beforeEach(() => {
    ddbDocMock = mockClient(DynamoDBDocumentClient);
    ddbDocMock.reset();
  });

  describe('constructor', () => {
    it('should create instance with required options', () => {
      const store = new DynamoDBStore({
        memoryTableName: 'memory',
      });

      expect(store).toBeInstanceOf(DynamoDBStore);
    });

    it('should create instance with all options', () => {
      const embedding = createMockEmbedding();
      const store = new DynamoDBStore({
        memoryTableName: 'memory',
        embedding,
        ttlDays: 30,
        clientConfig: { region: 'us-east-1' },
      });

      expect(store).toBeInstanceOf(DynamoDBStore);
    });

    it('should create instance without embedding', () => {
      const store = new DynamoDBStore({
        memoryTableName: 'memory',
        ttlDays: 30,
      });

      expect(store).toBeInstanceOf(DynamoDBStore);
    });
  });

  describe('batch - GetOperation', () => {
    it('should execute GetOperation', async () => {
      ddbDocMock.onAnyCommand().resolvesOnce({
        Item: createMockStoreItem('user-123', ['docs'], 'doc1', { data: 'value' }),
      });

      const store = new DynamoDBStore({ memoryTableName: 'memory' });

      const results = await store.batch(
        [
          {
            namespace: ['docs'],
            key: 'doc1',
          },
        ],
        { configurable: { user_id: 'user-123' } },
      );

      expect(results).toHaveLength(1);
      expect(results[0]).toBeDefined();
      expect(results[0]!.key).toBe('doc1');
    });

    it('should return null for non-existent item', async () => {
      ddbDocMock.onAnyCommand().resolvesOnce({});

      const store = new DynamoDBStore({ memoryTableName: 'memory' });

      const results = await store.batch(
        [
          {
            namespace: ['docs'],
            key: 'non-existent',
          },
        ],
        { configurable: { user_id: 'user-123' } },
      );

      expect(results).toHaveLength(1);
      expect(results[0]).toBeNull();
    });
  });

  describe('batch - PutOperation', () => {
    it('should execute PutOperation', async () => {
      ddbDocMock.onAnyCommand().resolvesOnce({});

      const store = new DynamoDBStore({ memoryTableName: 'memory' });

      const results = await store.batch(
        [
          {
            namespace: ['docs'],
            key: 'doc1',
            value: { data: 'value' },
          },
        ],
        { configurable: { user_id: 'user-123' } },
      );

      expect(results).toHaveLength(1);
      expect(results[0]).toBeUndefined();
    });

    it('should execute PutOperation with embeddings', async () => {
      const embedding = createMockEmbedding();
      ddbDocMock.onAnyCommand().resolvesOnce({});

      const store = new DynamoDBStore({
        memoryTableName: 'memory',
        embedding,
      });

      const results = await store.batch(
        [
          {
            namespace: ['docs'],
            key: 'doc1',
            value: { text: 'hello world' },
            index: ['$.text'],
          },
        ],
        { configurable: { user_id: 'user-123' } },
      );

      expect(results).toHaveLength(1);
      expect(embedding.embedDocuments).toHaveBeenCalledWith(['hello world']);
    });
  });

  describe('batch - SearchOperation', () => {
    it('should execute SearchOperation', async () => {
      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [createMockStoreItem('user-123', ['docs'], 'doc1', { data: 'value' })],
        ScannedCount: 1,
        LastEvaluatedKey: undefined,
      });

      const store = new DynamoDBStore({ memoryTableName: 'memory' });

      const results = await store.batch(
        [
          {
            namespacePrefix: ['docs'],
            limit: 10,
            offset: 0,
          },
        ],
        { configurable: { user_id: 'user-123' } },
      );

      expect(results).toHaveLength(1);
      expect(Array.isArray(results[0])).toBe(true);
      expect(results[0]).toHaveLength(1);
    });

    it('should execute SearchOperation with semantic search', async () => {
      const embedding = createMockEmbedding();
      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [
          {
            ...createMockStoreItem('user-123', ['docs'], 'doc1', { text: 'hello' }),
            embedding: [[1, 0, 0]],
          },
        ],
        ScannedCount: 1,
        LastEvaluatedKey: undefined,
      });

      const store = new DynamoDBStore({
        memoryTableName: 'memory',
        embedding,
      });

      const results = await store.batch(
        [
          {
            namespacePrefix: ['docs'],
            limit: 10,
            offset: 0,
            query: 'hello',
          },
        ],
        { configurable: { user_id: 'user-123' } },
      );

      expect(results).toHaveLength(1);
      expect(embedding.embedQuery).toHaveBeenCalledWith('hello');
    });
  });

  describe('batch - ListNamespacesOperation', () => {
    it('should execute ListNamespacesOperation', async () => {
      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [{ namespace: 'docs/guides' }, { namespace: 'docs/tutorials' }],
        LastEvaluatedKey: undefined,
      });

      const store = new DynamoDBStore({ memoryTableName: 'memory' });

      const results = await store.batch(
        [
          {
            limit: 10,
            offset: 0,
          },
        ],
        { configurable: { user_id: 'user-123' } },
      );

      expect(results).toHaveLength(1);
      expect(Array.isArray(results[0])).toBe(true);
      expect(results[0].length).toBeGreaterThan(0);
    });

    it('should execute ListNamespacesOperation with match conditions', async () => {
      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [{ namespace: 'docs/guides' }],
        LastEvaluatedKey: undefined,
      });

      const store = new DynamoDBStore({ memoryTableName: 'memory' });

      const results = await store.batch(
        [
          {
            limit: 10,
            offset: 0,
            matchConditions: [
              {
                matchType: 'prefix' as const,
                path: ['user-123', 'docs'],
              },
            ],
          },
        ],
        { configurable: { user_id: 'user-123' } },
      );

      expect(results).toHaveLength(1);
      expect(Array.isArray(results[0])).toBe(true);
    });
  });

  describe('batch - mixed operations', () => {
    it('should execute mixed operations in parallel', async () => {
      ddbDocMock.onAnyCommand().resolves({
        Item: createMockStoreItem('user-123', ['docs'], 'doc1', { data: 'value' }),
      });
      ddbDocMock.onAnyCommand().resolves({});
      ddbDocMock.onAnyCommand().resolves({
        Items: [],
        ScannedCount: 0,
        LastEvaluatedKey: undefined,
      });

      const store = new DynamoDBStore({ memoryTableName: 'memory' });

      const results = await store.batch(
        [
          { namespace: ['docs'], key: 'doc1' }, // Get
          { namespace: ['docs'], key: 'doc2', value: { data: 'value2' } }, // Put
          { namespacePrefix: ['docs'], limit: 10, offset: 0 }, // Search
        ],
        { configurable: { user_id: 'user-123' } },
      );

      expect(results).toHaveLength(3);
    });

    it('should handle all operations in single batch', async () => {
      ddbDocMock.onAnyCommand().resolves({});

      const store = new DynamoDBStore({ memoryTableName: 'memory' });

      const results = await store.batch(
        [
          { namespace: ['docs'], key: 'doc1' },
          { namespace: ['docs'], key: 'doc2', value: { data: 'value' } },
          { namespacePrefix: ['docs'], limit: 10, offset: 0 },
          { limit: 10, offset: 0 },
        ],
        { configurable: { user_id: 'user-123' } },
      );

      expect(results).toHaveLength(4);
    });
  });

  describe('batch - error handling', () => {
    it('should throw error for unrecognized operation', async () => {
      const store = new DynamoDBStore({ memoryTableName: 'memory' });

      await expect(
        store.batch([{ unknown: 'operation' } as any], { configurable: { user_id: 'user-123' } }),
      ).rejects.toThrow('Unrecognized operation type');
    });

    it('should include operation index in error', async () => {
      ddbDocMock.onAnyCommand().resolves({});

      const store = new DynamoDBStore({ memoryTableName: 'memory' });

      await expect(
        store.batch([{ namespace: ['docs'], key: 'doc1' }, { unknown: 'operation' } as any], {
          configurable: { user_id: 'user-123' },
        }),
      ).rejects.toThrow('index 1');
    });
  });

  describe('batch - validation', () => {
    it('should validate batch size', async () => {
      const store = new DynamoDBStore({ memoryTableName: 'memory' });

      const operations = Array(101)
        .fill(null)
        .map(() => ({ namespace: ['docs'], key: 'doc1' }));

      await expect(
        store.batch(operations, { configurable: { user_id: 'user-123' } }),
      ).rejects.toThrow('Batch size');
    });

    it('should accept batch at maximum size', async () => {
      ddbDocMock.onAnyCommand().resolves({});

      const store = new DynamoDBStore({ memoryTableName: 'memory' });

      const operations = Array(100)
        .fill(null)
        .map(() => ({ namespace: ['docs'], key: 'doc1' }));

      const results = await store.batch(operations, {
        configurable: { user_id: 'user-123' },
      });

      expect(results).toHaveLength(100);
    });

    it('should throw error for empty batch', async () => {
      const store = new DynamoDBStore({ memoryTableName: 'memory' });

      await expect(store.batch([], { configurable: { user_id: 'user-123' } })).rejects.toThrow(
        'Batch must contain at least one operation',
      );
    });
  });

  describe('getUserId', () => {
    it('should throw error when user_id is missing', async () => {
      const store = new DynamoDBStore({ memoryTableName: 'memory' });

      await expect(
        store.batch([{ namespace: ['docs'], key: 'doc1' }], { configurable: {} }),
      ).rejects.toThrow('Field user_id is required');
    });

    it('should throw error when user_id is not a string', async () => {
      const store = new DynamoDBStore({ memoryTableName: 'memory' });

      await expect(
        store.batch([{ namespace: ['docs'], key: 'doc1' }], {
          configurable: { user_id: 123 as any },
        }),
      ).rejects.toThrow('Field user_id is required');
    });

    it('should throw error when config is undefined', async () => {
      const store = new DynamoDBStore({ memoryTableName: 'memory' });

      await expect(store.batch([{ namespace: ['docs'], key: 'doc1' }], undefined)).rejects.toThrow(
        'Field user_id is required',
      );
    });

    it('should throw error when configurable is undefined', async () => {
      const store = new DynamoDBStore({ memoryTableName: 'memory' });

      await expect(store.batch([{ namespace: ['docs'], key: 'doc1' }], {})).rejects.toThrow(
        'Field user_id is required',
      );
    });
  });

  describe('parallel execution', () => {
    it('should execute operations in parallel', async () => {
      const delays: number[] = [];
      ddbDocMock.onAnyCommand().callsFake(async () => {
        const start = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 10));
        delays.push(Date.now() - start);
        return {};
      });

      const store = new DynamoDBStore({ memoryTableName: 'memory' });

      const startTime = Date.now();
      await store.batch(
        [
          { namespace: ['docs'], key: 'doc1' },
          { namespace: ['docs'], key: 'doc2' },
          { namespace: ['docs'], key: 'doc3' },
        ],
        { configurable: { user_id: 'user-123' } },
      );
      const totalTime = Date.now() - startTime;

      // If operations were sequential, it would take 30ms+
      // If parallel, should be close to 10ms (but allow some variance for CI/slow systems)
      expect(totalTime).toBeLessThan(30);
    });
  });

  describe('operation type detection', () => {
    it('should detect GetOperation by having key but not value', async () => {
      ddbDocMock.onAnyCommand().resolvesOnce({});

      const store = new DynamoDBStore({ memoryTableName: 'memory' });

      const results = await store.batch([{ namespace: ['docs'], key: 'doc1' }], {
        configurable: { user_id: 'user-123' },
      });

      expect(results).toHaveLength(1);
    });

    it('should detect PutOperation by having both key and value', async () => {
      ddbDocMock.onAnyCommand().resolvesOnce({});

      const store = new DynamoDBStore({ memoryTableName: 'memory' });

      const results = await store.batch(
        [{ namespace: ['docs'], key: 'doc1', value: { data: 'value' } }],
        { configurable: { user_id: 'user-123' } },
      );

      expect(results).toHaveLength(1);
    });

    it('should detect SearchOperation by having namespacePrefix', async () => {
      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [],
        ScannedCount: 0,
        LastEvaluatedKey: undefined,
      });

      const store = new DynamoDBStore({ memoryTableName: 'memory' });

      const results = await store.batch([{ namespacePrefix: ['docs'], limit: 10, offset: 0 }], {
        configurable: { user_id: 'user-123' },
      });

      expect(results).toHaveLength(1);
    });

    it('should detect ListNamespacesOperation by having limit/offset without namespacePrefix', async () => {
      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const store = new DynamoDBStore({ memoryTableName: 'memory' });

      const results = await store.batch([{ limit: 10, offset: 0 }], {
        configurable: { user_id: 'user-123' },
      });

      expect(results).toHaveLength(1);
    });
  });

  describe('ttlDays', () => {
    it('should pass ttlDays to put operations', async () => {
      ddbDocMock.onAnyCommand().resolvesOnce({});

      const store = new DynamoDBStore({
        memoryTableName: 'memory',
        ttlDays: 30,
      });

      await store.batch([{ namespace: ['docs'], key: 'doc1', value: { data: 'value' } }], {
        configurable: { user_id: 'user-123' },
      });

      expect(ddbDocMock.calls()).toHaveLength(1);
    });
  });

  describe('DynamoDB errors', () => {
    it('should handle DynamoDB errors with retry', async () => {
      ddbDocMock.onAnyCommand().rejectsOnce({ name: 'ThrottlingException' });
      ddbDocMock.onAnyCommand().resolvesOnce({});

      const store = new DynamoDBStore({ memoryTableName: 'memory' });

      const results = await store.batch([{ namespace: ['docs'], key: 'doc1' }], {
        configurable: { user_id: 'user-123' },
      });

      expect(results).toHaveLength(1);
    });
  });
});
