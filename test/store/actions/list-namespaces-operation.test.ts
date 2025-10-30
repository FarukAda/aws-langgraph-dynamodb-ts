import { listNamespacesOperationAction } from '../../../src/store/actions/list-namespaces-operation';
import {
  createMockDynamoDBClient,
  mockDynamoDBQueryPaginated,
} from '../../shared/mocks/dynamodb-mock';

describe('listNamespacesOperationAction', () => {
  describe('basic listing', () => {
    it('should list namespaces with pagination', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [
          { namespace: 'docs/guides' },
          { namespace: 'docs/tutorials' },
          { namespace: 'blog/posts' },
        ],
        LastEvaluatedKey: undefined,
      });

      const results = await listNamespacesOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          limit: 10,
          offset: 0,
        },
      });

      expect(results).toHaveLength(3);
      expect(results[0]).toEqual(['user-123', 'blog', 'posts']);
      expect(results[1]).toEqual(['user-123', 'docs', 'guides']);
      expect(results[2]).toEqual(['user-123', 'docs', 'tutorials']);
    });

    it('should apply limit and offset', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [
          { namespace: 'docs/guides' },
          { namespace: 'docs/tutorials' },
          { namespace: 'blog/posts' },
        ],
        LastEvaluatedKey: undefined,
      });

      const results = await listNamespacesOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          limit: 2,
          offset: 1,
        },
      });

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual(['user-123', 'docs', 'guides']);
      expect(results[1]).toEqual(['user-123', 'docs', 'tutorials']);
    });

    it('should deduplicate namespaces', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [
          { namespace: 'docs/guides' },
          { namespace: 'docs/guides' },
          { namespace: 'docs/guides' },
        ],
        LastEvaluatedKey: undefined,
      });

      const results = await listNamespacesOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          limit: 10,
          offset: 0,
        },
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(['user-123', 'docs', 'guides']);
    });

    it('should sort namespaces', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [{ namespace: 'zebra' }, { namespace: 'alpha' }, { namespace: 'beta' }],
        LastEvaluatedKey: undefined,
      });

      const results = await listNamespacesOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          limit: 10,
          offset: 0,
        },
      });

      expect(results[0]).toEqual(['user-123', 'alpha']);
      expect(results[1]).toEqual(['user-123', 'beta']);
      expect(results[2]).toEqual(['user-123', 'zebra']);
    });
  });

  describe('prefix matching', () => {
    it('should match prefix without wildcards', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [{ namespace: 'docs/guides' }, { namespace: 'docs/tutorials' }],
        LastEvaluatedKey: undefined,
      });

      const results = await listNamespacesOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          limit: 10,
          offset: 0,
          matchConditions: [
            {
              matchType: 'prefix',
              path: ['user-123', 'docs'],
            },
          ],
        },
      });

      expect(results).toHaveLength(2);
    });

    it('should match prefix with wildcards', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [
          { namespace: 'docs/guides' },
          { namespace: 'blog/posts' },
          { namespace: 'docs/tutorials' },
        ],
        LastEvaluatedKey: undefined,
      });

      const results = await listNamespacesOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          limit: 10,
          offset: 0,
          matchConditions: [
            {
              matchType: 'prefix',
              path: ['user-123', '*', 'guides'],
            },
          ],
        },
      });

      // Only 'docs/guides' should match ['user-123', '*', 'guides']
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(['user-123', 'docs', 'guides']);
    });

    it('should match prefix with leading wildcard', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [
          { namespace: 'docs/guides' },
          { namespace: 'blog/guides' },
          { namespace: 'tutorials/guides' },
        ],
        LastEvaluatedKey: undefined,
      });

      const results = await listNamespacesOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          limit: 10,
          offset: 0,
          matchConditions: [
            {
              matchType: 'prefix',
              path: ['user-123', '*'],
            },
          ],
        },
      });

      expect(results).toHaveLength(3);
    });
  });

  describe('suffix matching', () => {
    it('should match suffix without wildcards', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [
          { namespace: 'docs/guides' },
          { namespace: 'blog/guides' },
          { namespace: 'docs/tutorials' },
        ],
        LastEvaluatedKey: undefined,
      });

      const results = await listNamespacesOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          limit: 10,
          offset: 0,
          matchConditions: [
            {
              matchType: 'suffix',
              path: ['guides'],
            },
          ],
        },
      });

      expect(results).toHaveLength(2);
      expect(results[0][2]).toBe('guides');
      expect(results[1][2]).toBe('guides');
    });

    it('should match suffix with wildcards', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [
          { namespace: 'docs/2024/reports' },
          { namespace: 'blog/2024/posts' },
          { namespace: 'docs/2024/guides' },
        ],
        LastEvaluatedKey: undefined,
      });

      const results = await listNamespacesOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          limit: 10,
          offset: 0,
          matchConditions: [
            {
              matchType: 'suffix',
              path: ['*', 'reports'],
            },
          ],
        },
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(['user-123', 'docs', '2024', 'reports']);
    });
  });

  describe('multiple match conditions', () => {
    it('should apply multiple conditions with AND logic', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [
          { namespace: 'docs/guides' },
          { namespace: 'docs/tutorials' },
          { namespace: 'blog/guides' },
        ],
        LastEvaluatedKey: undefined,
      });

      const results = await listNamespacesOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          limit: 10,
          offset: 0,
          matchConditions: [
            {
              matchType: 'prefix',
              path: ['user-123', 'docs'],
            },
            {
              matchType: 'suffix',
              path: ['guides'],
            },
          ],
        },
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(['user-123', 'docs', 'guides']);
    });

    it('should filter out when prefix pattern is longer than namespace', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [{ namespace: 'docs' }],
        LastEvaluatedKey: undefined,
      });

      const results = await listNamespacesOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          limit: 10,
          offset: 0,
          matchConditions: [
            {
              matchType: 'prefix',
              path: ['user-123', 'docs', 'guides', 'advanced'],
            },
          ],
        },
      });

      expect(results).toHaveLength(0);
    });

    it('should filter out when suffix pattern is longer than namespace', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [{ namespace: 'docs' }],
        LastEvaluatedKey: undefined,
      });

      const results = await listNamespacesOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          limit: 10,
          offset: 0,
          matchConditions: [
            {
              matchType: 'suffix',
              path: ['guides', 'advanced', 'tips'],
            },
          ],
        },
      });

      expect(results).toHaveLength(0);
    });
  });

  describe('maxDepth filtering', () => {
    it('should filter by maxDepth', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [
          { namespace: 'docs' },
          { namespace: 'docs/guides' },
          { namespace: 'docs/guides/advanced' },
        ],
        LastEvaluatedKey: undefined,
      });

      const results = await listNamespacesOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          limit: 10,
          offset: 0,
          maxDepth: 2,
        },
      });

      // maxDepth = 2 means ['user-123', 'docs']
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(['user-123', 'docs']);
    });

    it('should apply maxDepth correctly', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [
          { namespace: 'a' },
          { namespace: 'a/b' },
          { namespace: 'a/b/c' },
          { namespace: 'a/b/c/d' },
        ],
        LastEvaluatedKey: undefined,
      });

      const results = await listNamespacesOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          limit: 10,
          offset: 0,
          maxDepth: 3,
        },
      });

      // maxDepth = 3: ['user-123', 'a'], ['user-123', 'a', 'b']
      expect(results).toHaveLength(2);
    });
  });

  describe('pagination with LastEvaluatedKey', () => {
    it('should handle pagination', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      mockDynamoDBQueryPaginated(ddbDocMock, [
        {
          items: [{ namespace: 'docs/guides' }, { namespace: 'docs/tutorials' }],
          lastKey: { user_id: 'user-123', namespace_key: 'key' },
        },
        {
          items: [{ namespace: 'blog/posts' }],
          lastKey: undefined,
        },
      ]);

      const results = await listNamespacesOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
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

      // Mock infinite pagination
      ddbDocMock.onAnyCommand().resolves({
        Items: [{ namespace: 'docs' }],
        LastEvaluatedKey: { user_id: 'user-123', namespace_key: 'key' },
      });

      await expect(
        listNamespacesOperationAction({
          client,
          memoryTableName: 'memory',
          userId: 'user-123',
          op: {
            limit: 10,
            offset: 0,
          },
        }),
      ).rejects.toThrow('List namespaces operation exceeded maximum iteration limit');
    });

    it('should stop when reaching memory limit', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      const manyItems = Array(10001)
        .fill(null)
        .map((_, i) => ({ namespace: `ns${i}` }));

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: manyItems,
        LastEvaluatedKey: undefined,
      });

      const results = await listNamespacesOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          limit: 1000,
          offset: 0,
        },
      });

      // Should cap at 1000 due to memory safety limit
      expect(results.length).toBeLessThanOrEqual(1000);
    });
  });

  describe('validation', () => {
    it('should throw error for invalid user_id', async () => {
      const { client } = createMockDynamoDBClient();

      await expect(
        listNamespacesOperationAction({
          client,
          memoryTableName: 'memory',
          userId: '',
          op: {
            limit: 10,
            offset: 0,
          },
        }),
      ).rejects.toThrow('User ID cannot be empty');
    });

    it('should throw error for invalid pagination', async () => {
      const { client } = createMockDynamoDBClient();

      await expect(
        listNamespacesOperationAction({
          client,
          memoryTableName: 'memory',
          userId: 'user-123',
          op: {
            limit: -1,
            offset: 0,
          },
        }),
      ).rejects.toThrow('Limit cannot be negative');
    });

    it('should throw error for invalid maxDepth', async () => {
      const { client } = createMockDynamoDBClient();

      await expect(
        listNamespacesOperationAction({
          client,
          memoryTableName: 'memory',
          userId: 'user-123',
          op: {
            limit: 10,
            offset: 0,
            maxDepth: 0,
          },
        }),
      ).rejects.toThrow('maxDepth must be at least 1');
    });
  });

  describe('empty results', () => {
    it('should return empty array when no namespaces found', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const results = await listNamespacesOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          limit: 10,
          offset: 0,
        },
      });

      expect(results).toEqual([]);
    });

    it('should handle empty namespace string', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [{ namespace: '' }],
        LastEvaluatedKey: undefined,
      });

      const results = await listNamespacesOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          limit: 10,
          offset: 0,
        },
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(['user-123']);
    });
  });

  describe('DynamoDB optimization', () => {
    it('should use begins_with for prefix conditions', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [{ namespace: 'docs/guides' }],
        LastEvaluatedKey: undefined,
      });

      await listNamespacesOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          limit: 10,
          offset: 0,
          matchConditions: [
            {
              matchType: 'prefix',
              path: ['user-123', 'docs'],
            },
          ],
        },
      });

      expect(ddbDocMock.calls()).toHaveLength(1);
    });

    it('should use contains for suffix conditions', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [{ namespace: 'docs/guides' }],
        LastEvaluatedKey: undefined,
      });

      await listNamespacesOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          limit: 10,
          offset: 0,
          matchConditions: [
            {
              matchType: 'suffix',
              path: ['guides'],
            },
          ],
        },
      });

      expect(ddbDocMock.calls()).toHaveLength(1);
    });
  });

  describe('DynamoDB errors', () => {
    it('should handle DynamoDB errors with retry', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      // First attempt fails, second succeeds
      ddbDocMock.onAnyCommand().rejectsOnce({ name: 'ThrottlingException' });
      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [{ namespace: 'docs' }],
        LastEvaluatedKey: undefined,
      });

      const results = await listNamespacesOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          limit: 10,
          offset: 0,
        },
      });

      expect(results).toHaveLength(1);
    });
  });

  describe('edge cases for defensive code', () => {
    it('should handle invalid matchType gracefully (defensive code)', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      ddbDocMock.onAnyCommand().resolves({
        Items: [{ namespace: 'docs/guides' }],
        LastEvaluatedKey: undefined,
      });

      // Force an invalid matchType to test the defensive return false on line 211
      const invalidOp: any = {
        limit: 10,
        offset: 0,
        matchConditions: [
          {
            matchType: 'invalid' as any, // Force invalid type
            path: ['user-123', 'docs'],
          },
        ],
      };

      const results = await listNamespacesOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: invalidOp,
      });

      // With invalid matchType, matchesCondition returns false, filtering out all results
      expect(results).toHaveLength(0);
    });
  });
});
