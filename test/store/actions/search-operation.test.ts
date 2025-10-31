import { searchOperationAction } from '../../../src/store/actions';
import {
  createMockDynamoDBClient,
  mockDynamoDBQueryPaginated,
} from '../../shared/mocks/dynamodb-mock';
import { createMockEmbeddingWithVector } from '../../shared/mocks/embedding-mock';
import { createMockStoreItem } from '../../shared/fixtures/test-data';

describe('searchOperationAction', () => {
  describe('basic search without semantic search', () => {
    it('should search without query', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      const items = [
        createMockStoreItem('user-123', ['docs'], 'doc1', { title: 'Document 1' }),
        createMockStoreItem('user-123', ['docs'], 'doc2', { title: 'Document 2' }),
      ];

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: items,
        ScannedCount: 2,
        LastEvaluatedKey: undefined,
      });

      const results = await searchOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          namespacePrefix: ['docs'],
          limit: 10,
          offset: 0,
        },
      });

      expect(results).toHaveLength(2);
      expect(results[0].key).toBe('doc1');
      expect(results[1].key).toBe('doc2');
    });

    it('should search with empty namespace prefix', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      const items = [createMockStoreItem('user-123', ['docs'], 'doc1', { title: 'Document 1' })];

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: items,
        ScannedCount: 1,
        LastEvaluatedKey: undefined,
      });

      const results = await searchOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          namespacePrefix: [],
          limit: 10,
          offset: 0,
        },
      });

      expect(results).toHaveLength(1);
    });

    it('should apply filter expressions', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      const items = [
        createMockStoreItem('user-123', ['docs'], 'doc1', {
          title: 'Document 1',
          status: 'active',
        }),
      ];

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: items,
        ScannedCount: 1,
        LastEvaluatedKey: undefined,
      });

      const results = await searchOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          namespacePrefix: ['docs'],
          limit: 10,
          offset: 0,
          filter: { status: 'active' },
        },
      });

      expect(results).toHaveLength(1);
    });
  });

  describe('semantic search with embeddings', () => {
    it('should perform semantic search with cosine similarity', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();
      const embedding = createMockEmbeddingWithVector([1, 0, 0]);

      const items = [
        {
          ...createMockStoreItem('user-123', ['docs'], 'doc1', { text: 'hello' }),
          embedding: [[1, 0, 0]], // Perfect match
        },
        {
          ...createMockStoreItem('user-123', ['docs'], 'doc2', { text: 'world' }),
          embedding: [[0, 1, 0]], // Orthogonal
        },
      ];

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: items,
        ScannedCount: 2,
        LastEvaluatedKey: undefined,
      });

      const results = await searchOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          namespacePrefix: ['docs'],
          limit: 10,
          offset: 0,
          query: 'hello',
        },
        embedding,
      });

      expect(results).toHaveLength(1); // Only items with embeddings
      expect(results[0].key).toBe('doc1');
      expect(results[0].score).toBe(1);
    });

    it('should filter out items without embeddings', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();
      const embedding = createMockEmbeddingWithVector([1, 0, 0]);

      const items = [
        {
          ...createMockStoreItem('user-123', ['docs'], 'doc1', { text: 'hello' }),
          embedding: [[1, 0, 0]],
        },
        createMockStoreItem('user-123', ['docs'], 'doc2', { text: 'world' }), // No embedding
      ];

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: items,
        ScannedCount: 2,
        LastEvaluatedKey: undefined,
      });

      const results = await searchOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          namespacePrefix: ['docs'],
          limit: 10,
          offset: 0,
          query: 'hello',
        },
        embedding,
      });

      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('doc1');
    });

    it('should use max similarity for items with multiple embeddings', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();
      const embedding = createMockEmbeddingWithVector([1, 0, 0]);

      const items = [
        {
          ...createMockStoreItem('user-123', ['docs'], 'doc1', { text: 'hello' }),
          embedding: [
            [0, 1, 0], // Low similarity
            [1, 0, 0], // High similarity
            [0, 0, 1], // Low similarity
          ],
        },
      ];

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: items,
        ScannedCount: 1,
        LastEvaluatedKey: undefined,
      });

      const results = await searchOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          namespacePrefix: ['docs'],
          limit: 10,
          offset: 0,
          query: 'hello',
        },
        embedding,
      });

      expect(results).toHaveLength(1);
      expect(results[0].score).toBe(1); // Max similarity
    });

    it('should sort by similarity score descending', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();
      const embedding = createMockEmbeddingWithVector([1, 0, 0]);

      const items = [
        {
          ...createMockStoreItem('user-123', ['docs'], 'doc1', { text: 'hello' }),
          embedding: [[0.5, 0.5, 0]], // Lower similarity
        },
        {
          ...createMockStoreItem('user-123', ['docs'], 'doc2', { text: 'world' }),
          embedding: [[1, 0, 0]], // Higher similarity
        },
      ];

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: items,
        ScannedCount: 2,
        LastEvaluatedKey: undefined,
      });

      const results = await searchOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          namespacePrefix: ['docs'],
          limit: 10,
          offset: 0,
          query: 'hello',
        },
        embedding,
      });

      expect(results[0].key).toBe('doc2'); // Higher score first
      expect(results[1].key).toBe('doc1');
    });

    it('should handle zero-magnitude item vectors', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();
      const embedding = createMockEmbeddingWithVector([1, 0, 0]); // Valid query vector

      const items = [
        {
          ...createMockStoreItem('user-123', ['docs'], 'doc1', { text: 'hello' }),
          embedding: [[0, 0, 0]], // Zero magnitude item embedding
        },
        {
          ...createMockStoreItem('user-123', ['docs'], 'doc2', { text: 'world' }),
          embedding: [[1, 0, 0]], // Valid item embedding
        },
      ];

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: items,
        LastEvaluatedKey: undefined,
      });

      const results = await searchOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          namespacePrefix: ['docs'],
          limit: 10,
          offset: 0,
          query: 'test query',
        },
        embedding,
      });

      // Only item with non-zero similarity should be included (doc2)
      // Item with zero-magnitude embedding gets score 0 and is filtered out
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('doc2');
      expect(results[0].score).toBe(1);
    });

    it('should handle mismatched embedding dimensions', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();
      const embedding = createMockEmbeddingWithVector([1, 0, 0]); // 3D query vector

      const items = [
        {
          ...createMockStoreItem('user-123', ['docs'], 'doc1', { text: 'hello' }),
          embedding: [[1, 0]], // 2D item embedding - mismatched dimensions
        },
        {
          ...createMockStoreItem('user-123', ['docs'], 'doc2', { text: 'world' }),
          embedding: [[1, 0, 0]], // 3D item embedding - matches a query
        },
      ];

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: items,
        LastEvaluatedKey: undefined,
      });

      const results = await searchOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          namespacePrefix: ['docs'],
          limit: 10,
          offset: 0,
          query: 'test query',
        },
        embedding,
      });

      // Only item with matching dimensions should be included (doc2)
      // Item with mismatched dimensions gets score 0 and is filtered out
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('doc2');
    });

    it('should fallback to original items on embedding error', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();
      const embedding = {
        embedQuery: jest.fn().mockRejectedValue(new Error('Embedding failed')),
      } as any;

      const items = [
        {
          ...createMockStoreItem('user-123', ['docs'], 'doc1', { text: 'hello' }),
          embedding: [[1, 0, 0]],
        },
      ];

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: items,
        ScannedCount: 1,
        LastEvaluatedKey: undefined,
      });

      const results = await searchOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          namespacePrefix: ['docs'],
          limit: 10,
          offset: 0,
          query: 'hello',
        },
        embedding,
      });

      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('doc1');
    });
  });

  describe('pagination', () => {
    it('should handle pagination with limit and offset', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      const items = Array(5)
        .fill(null)
        .map((_, i) => createMockStoreItem('user-123', ['docs'], `doc${i}`, { title: `Doc ${i}` }));

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: items,
        ScannedCount: 5,
        LastEvaluatedKey: undefined,
      });

      const results = await searchOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          namespacePrefix: ['docs'],
          limit: 2,
          offset: 1,
        },
      });

      expect(results).toHaveLength(2);
      expect(results[0].key).toBe('doc1');
      expect(results[1].key).toBe('doc2');
    });

    it('should handle pagination with LastEvaluatedKey', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      mockDynamoDBQueryPaginated(ddbDocMock, [
        {
          items: [
            createMockStoreItem('user-123', ['docs'], 'doc1', { title: 'Doc 1' }),
            createMockStoreItem('user-123', ['docs'], 'doc2', { title: 'Doc 2' }),
          ],
          lastKey: { user_id: 'user-123', namespace_key: 'docs#doc2' },
        },
        {
          items: [createMockStoreItem('user-123', ['docs'], 'doc3', { title: 'Doc 3' })],
          lastKey: undefined,
        },
      ]);

      const results = await searchOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          namespacePrefix: ['docs'],
          limit: 10,
          offset: 0,
        },
      });

      expect(results).toHaveLength(3);
    });
  });

  describe('safety limits', () => {
    it('should throw error when exceeding max iterations', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      // Mock infinite pagination - each iteration returns 1 item
      // With limit=1000 and 1 item per iteration, needs >100 iterations to satisfy the limit
      ddbDocMock.onAnyCommand().resolves({
        Items: [createMockStoreItem('user-123', ['docs'], 'doc1', { title: 'Doc 1' })],
        ScannedCount: 1,
        LastEvaluatedKey: { user_id: 'user-123', namespace_key: 'docs#doc1' },
      });

      await expect(
        searchOperationAction({
          client,
          memoryTableName: 'memory',
          userId: 'user-123',
          op: {
            namespacePrefix: ['docs'],
            limit: 1000,
            offset: 0,
          },
        }),
      ).rejects.toThrow('Search operation exceeded maximum iteration limit');
    });

    it('should throw error when exceeding max items in memory', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      // Create one huge response that exceeds the limit in a single batch
      const hugeItemList = Array(10001)
        .fill(null)
        .map((_, i) => createMockStoreItem('user-123', ['docs'], `doc${i}`, { title: `Doc ${i}` }));

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: hugeItemList,
        ScannedCount: 10001,
        LastEvaluatedKey: undefined,
      });

      await expect(
        searchOperationAction({
          client,
          memoryTableName: 'memory',
          userId: 'user-123',
          op: {
            namespacePrefix: ['docs'],
            limit: 100,
            offset: 0,
          },
        }),
      ).rejects.toThrow('Search operation exceeded maximum items in memory limit');
    });
  });

  describe('validation', () => {
    it('should throw error for invalid user_id', async () => {
      const { client } = createMockDynamoDBClient();

      await expect(
        searchOperationAction({
          client,
          memoryTableName: 'memory',
          userId: '',
          op: {
            namespacePrefix: ['docs'],
            limit: 10,
            offset: 0,
          },
        }),
      ).rejects.toThrow('User ID cannot be empty');
    });

    it('should throw error for invalid namespace', async () => {
      const { client } = createMockDynamoDBClient();

      await expect(
        searchOperationAction({
          client,
          memoryTableName: 'memory',
          userId: 'user-123',
          op: {
            namespacePrefix: ['invalid#namespace'],
            limit: 10,
            offset: 0,
          },
        }),
      ).rejects.toThrow('Namespace parts cannot contain "#" character');
    });

    it('should throw error for invalid pagination', async () => {
      const { client } = createMockDynamoDBClient();

      await expect(
        searchOperationAction({
          client,
          memoryTableName: 'memory',
          userId: 'user-123',
          op: {
            namespacePrefix: ['docs'],
            limit: -1,
            offset: 0,
          },
        }),
      ).rejects.toThrow('Limit cannot be negative');
    });
  });

  describe('result transformation', () => {
    it('should transform items correctly', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      const now = Date.now();
      const item = {
        user_id: 'user-123',
        namespace_key: 'docs/guides#guide1',
        namespace: 'docs/guides',
        key: 'guide1',
        value: { title: 'Guide 1' },
        createdAt: now - 1000,
        updatedAt: now,
      };

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [item],
        ScannedCount: 1,
        LastEvaluatedKey: undefined,
      });

      const results = await searchOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          namespacePrefix: ['docs', 'guides'],
          limit: 10,
          offset: 0,
        },
      });

      expect(results[0].namespace).toEqual(['docs', 'guides']);
      expect(results[0].key).toBe('guide1');
      expect(results[0].value).toEqual({ title: 'Guide 1' });
      expect(results[0].createdAt).toBe(now - 1000);
      expect(results[0].updatedAt).toBe(now);
    });
  });

  describe('DynamoDB errors', () => {
    it('should handle DynamoDB errors with retry', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      // First attempt fails, second succeeds
      ddbDocMock.onAnyCommand().rejectsOnce({ name: 'ThrottlingException' });
      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [createMockStoreItem('user-123', ['docs'], 'doc1', { title: 'Doc 1' })],
        ScannedCount: 1,
        LastEvaluatedKey: undefined,
      });

      const results = await searchOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          namespacePrefix: ['docs'],
          limit: 10,
          offset: 0,
        },
      });

      expect(results).toHaveLength(1);
    });
  });

  describe('empty results', () => {
    it('should return empty array when no items found', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [],
        ScannedCount: 0,
        LastEvaluatedKey: undefined,
      });

      const results = await searchOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          namespacePrefix: ['docs'],
          limit: 10,
          offset: 0,
        },
      });

      expect(results).toEqual([]);
    });
  });

  describe('default values', () => {
    it('should use default limit when not provided', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [],
        ScannedCount: 0,
        LastEvaluatedKey: undefined,
      });

      const results = await searchOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          namespacePrefix: ['docs'],
        },
      });

      expect(results).toEqual([]);
    });

    it('should use default offset when not provided', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [],
        ScannedCount: 0,
        LastEvaluatedKey: undefined,
      });

      const results = await searchOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          namespacePrefix: ['docs'],
          limit: 10,
        },
      });

      expect(results).toEqual([]);
    });
  });
});
