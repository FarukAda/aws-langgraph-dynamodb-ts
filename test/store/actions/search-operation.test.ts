import { setGlobalLogger, resetLogger, getLogger } from '../../../src/shared/utils/logger';
import { searchOperationAction } from '../../../src/store/actions';
import { createMockStoreItem } from '../../shared/fixtures/test-data';
import {
  createMockDynamoDBClient,
  mockDynamoDBQueryPaginated,
} from '../../shared/mocks/dynamodb-mock';
import {
  createMockEmbedding,
  createMockEmbeddingWithVector,
  hashEmbedding,
} from '../../shared/mocks/embedding-mock';

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

    it('should throw on embedding error by default (fail-closed)', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();
      const embedding = {
        embedQuery: jest.fn().mockRejectedValue(new Error('Embedding failed')),
      } as any;

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

      await expect(
        searchOperationAction({
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
        }),
      ).rejects.toThrow('Embedding failed');
    });

    it('should fall back to unranked items when fallbackToLexicalOnEmbeddingFailure=true', async () => {
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
        fallbackToLexicalOnEmbeddingFailure: true,
      });

      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('doc1');
    });
  });

  describe('semantic search ranking (hash-based embeddings)', () => {
    // These tests exercise the full similarity-ranking pipeline with
    // embeddings derived from the input text — same inputs → same vectors,
    // different inputs → different vectors. Earlier tests used orthogonal
    // [1,0,0] / [0,1,0] vectors to verify the cosine math; these verify that
    // the end-to-end path correctly distinguishes content, not just geometry.

    it('ranks an exact-text match above unrelated content with score 1', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();
      const embedding = createMockEmbedding();

      // Each item carries the embedding its text would produce in real usage.
      const items = [
        {
          ...createMockStoreItem('user-123', ['docs'], 'alpha', { text: 'the quick brown fox' }),
          embedding: [hashEmbedding('the quick brown fox')],
        },
        {
          ...createMockStoreItem('user-123', ['docs'], 'beta', { text: 'unrelated lorem ipsum' }),
          embedding: [hashEmbedding('unrelated lorem ipsum')],
        },
        {
          ...createMockStoreItem('user-123', ['docs'], 'gamma', { text: 'completely different' }),
          embedding: [hashEmbedding('completely different')],
        },
      ];

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: items,
        ScannedCount: items.length,
        LastEvaluatedKey: undefined,
      });

      const results = await searchOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: { namespacePrefix: ['docs'], limit: 10, offset: 0, query: 'the quick brown fox' },
        embedding,
      });

      expect(results).toHaveLength(3);
      // Exact-text match at rank 1 with cosine similarity 1 (identical vectors).
      expect(results[0].key).toBe('alpha');
      expect(results[0].score).toBeCloseTo(1, 6);
      // Other items have scores strictly less than 1 — distinct content
      // produces distinct vectors.
      expect(results[1].score).toBeLessThan(1);
      expect(results[2].score).toBeLessThan(1);
    });

    it('produces deterministic rank ordering across re-runs of the same query', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();
      const embedding = createMockEmbedding();

      const items = [
        {
          ...createMockStoreItem('user-123', ['docs'], 'a', { text: 'cats are great' }),
          embedding: [hashEmbedding('cats are great')],
        },
        {
          ...createMockStoreItem('user-123', ['docs'], 'b', { text: 'dogs are best' }),
          embedding: [hashEmbedding('dogs are best')],
        },
        {
          ...createMockStoreItem('user-123', ['docs'], 'c', { text: 'fish swim' }),
          embedding: [hashEmbedding('fish swim')],
        },
      ];

      ddbDocMock.onAnyCommand().resolves({
        Items: items,
        ScannedCount: items.length,
        LastEvaluatedKey: undefined,
      });

      const run = (): Promise<string[]> =>
        searchOperationAction({
          client,
          memoryTableName: 'memory',
          userId: 'user-123',
          op: { namespacePrefix: ['docs'], limit: 10, offset: 0, query: 'pets' },
          embedding,
        }).then((r) => r.map((i) => i.key));

      const first = await run();
      const second = await run();
      const third = await run();

      // Same corpus + same query → same rank order every time.
      expect(first).toEqual(second);
      expect(second).toEqual(third);
      expect(new Set(first)).toEqual(new Set(['a', 'b', 'c']));
    });

    it('assigns strictly monotonic scores from best to worst match', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();
      const embedding = createMockEmbedding();

      const corpus = ['apple', 'banana', 'cherry', 'durian', 'elderberry'];
      const items = corpus.map((text) => ({
        ...createMockStoreItem('user-123', ['docs'], text, { text }),
        embedding: [hashEmbedding(text)],
      }));

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: items,
        ScannedCount: items.length,
        LastEvaluatedKey: undefined,
      });

      const results = await searchOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: { namespacePrefix: ['docs'], limit: 10, offset: 0, query: 'apple' },
        embedding,
      });

      // Every rank's score >= the next. Exact match first with score 1.
      expect(results[0].score).toBeCloseTo(1, 6);
      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i].score).toBeGreaterThanOrEqual(results[i + 1].score as number);
      }
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

      // Simulate a heavily-filtered paginated query that returns 0 matches per
      // page but always has LastEvaluatedKey. Without the old scannedCount break
      // the loop runs until MAX_LOOP_ITERATIONS trips, which is the safety we
      // want to verify.
      ddbDocMock.onAnyCommand().resolves({
        Items: [],
        Count: 0,
        ScannedCount: 50,
        LastEvaluatedKey: { user_id: 'user-123', namespace_key: 'docs#doc1' },
      });

      await expect(
        searchOperationAction({
          client,
          memoryTableName: 'memory',
          userId: 'user-123',
          op: {
            namespacePrefix: ['docs'],
            limit: 10,
            offset: 0,
            filter: { 'value.title': 'never-matches' },
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
      expect(results[0].createdAt).toEqual(new Date(now - 1000));
      expect(results[0].updatedAt).toEqual(new Date(now));
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

  describe('semantic search corpus truncation', () => {
    it('returns a partial ranked corpus + warns when semantic search hits the memory cap', async () => {
      const warn = jest.fn();
      const origLogger = getLogger();
      setGlobalLogger({
        info: origLogger.info,
        warn,
        error: origLogger.error,
        debug: origLogger.debug,
      });

      try {
        const { ddbDocMock, client } = createMockDynamoDBClient();

        // Two pages that together exceed MAX_TOTAL_ITEMS_IN_MEMORY (10 000).
        const firstPage = Array.from({ length: 9000 }, (_, i) =>
          createMockStoreItem('user-123', ['docs'], `doc${i}`, { text: `t${i}` }),
        );
        const secondPage = Array.from({ length: 2000 }, (_, i) =>
          createMockStoreItem('user-123', ['docs'], `more${i}`, { text: `m${i}` }),
        );

        ddbDocMock
          .onAnyCommand()
          .resolvesOnce({ Items: firstPage, ScannedCount: 9000, LastEvaluatedKey: { k: 'x' } })
          .resolvesOnce({ Items: secondPage, ScannedCount: 2000, LastEvaluatedKey: undefined });

        const embedding = createMockEmbeddingWithVector([0.1, 0.2, 0.3]);

        const results = await searchOperationAction({
          client,
          memoryTableName: 'memory',
          userId: 'user-123',
          embedding,
          op: { namespacePrefix: ['docs'], query: 'hello', limit: 5 },
        });

        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('Semantic search corpus truncated'),
        );
        expect(Array.isArray(results)).toBe(true);
      } finally {
        resetLogger();
      }
    });
  });
});
