import { putOperationAction } from '../../../src/store/actions/put-operation';
import { createMockDynamoDBClient } from '../../shared/mocks/dynamodb-mock';
import { createMockEmbedding } from '../../shared/mocks/embedding-mock';

describe('putOperationAction', () => {
  it('should put item without embeddings', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    ddbDocMock.onAnyCommand().resolvesOnce({});

    await putOperationAction({
      client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['namespace'],
        key: 'key1',
        value: { data: 'value' },
      },
    });

    expect(ddbDocMock.calls()).toHaveLength(1);
  });

  it('should put item with embeddings', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();
    const embedding = createMockEmbedding();

    ddbDocMock.onAnyCommand().resolvesOnce({});

    await putOperationAction({
      client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['namespace'],
        key: 'key1',
        value: { text: 'hello world' },
        index: ['$.text'],
      },
      embedding,
    });

    expect(embedding.embedDocuments).toHaveBeenCalledWith(['hello world']);
    expect(ddbDocMock.calls()).toHaveLength(1);
  });

  it('should put item with TTL', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    ddbDocMock.onAnyCommand().resolvesOnce({});

    await putOperationAction({
      client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['namespace'],
        key: 'key1',
        value: { data: 'value' },
      },
      ttlDays: 30,
    });

    expect(ddbDocMock.calls()).toHaveLength(1);
  });

  it('should extract string values from JSONPath', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();
    const embedding = createMockEmbedding();

    ddbDocMock.onAnyCommand().resolvesOnce({});

    await putOperationAction({
      client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['namespace'],
        key: 'key1',
        value: { title: 'Hello', description: 'World' },
        index: ['$.title', '$.description'],
      },
      embedding,
    });

    expect(embedding.embedDocuments).toHaveBeenCalledWith(['Hello', 'World']);
  });

  it('should extract number values from JSONPath', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();
    const embedding = createMockEmbedding();

    ddbDocMock.onAnyCommand().resolvesOnce({});

    await putOperationAction({
      client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['namespace'],
        key: 'key1',
        value: { count: 42 },
        index: ['$.count'],
      },
      embedding,
    });

    expect(embedding.embedDocuments).toHaveBeenCalledWith(['42']);
  });

  it('should extract boolean values from JSONPath', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();
    const embedding = createMockEmbedding();

    ddbDocMock.onAnyCommand().resolvesOnce({});

    await putOperationAction({
      client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['namespace'],
        key: 'key1',
        value: { active: true },
        index: ['$.active'],
      },
      embedding,
    });

    expect(embedding.embedDocuments).toHaveBeenCalledWith(['true']);
  });

  it('should stringify object values from JSONPath', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();
    const embedding = createMockEmbedding();

    ddbDocMock.onAnyCommand().resolvesOnce({});

    await putOperationAction({
      client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['namespace'],
        key: 'key1',
        value: { user: { name: 'John', age: 30 } },
        index: ['$.user'],
      },
      embedding,
    });

    expect(embedding.embedDocuments).toHaveBeenCalledWith([
      JSON.stringify({ name: 'John', age: 30 }),
    ]);
  });

  it('should skip null and undefined values from JSONPath', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();
    const embedding = createMockEmbedding();

    ddbDocMock.onAnyCommand().resolvesOnce({});

    await putOperationAction({
      client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['namespace'],
        key: 'key1',
        value: { text: 'hello', empty: null, missing: undefined },
        index: ['$.text', '$.empty', '$.missing'],
      },
      embedding,
    });

    expect(embedding.embedDocuments).toHaveBeenCalledWith(['hello']);
  });

  it('should not generate embeddings when no index provided', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();
    const embedding = createMockEmbedding();

    ddbDocMock.onAnyCommand().resolvesOnce({});

    await putOperationAction({
      client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['namespace'],
        key: 'key1',
        value: { text: 'hello' },
      },
      embedding,
    });

    expect(embedding.embedDocuments).not.toHaveBeenCalled();
  });

  it('should not generate embeddings when index is empty', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();
    const embedding = createMockEmbedding();

    ddbDocMock.onAnyCommand().resolvesOnce({});

    await putOperationAction({
      client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['namespace'],
        key: 'key1',
        value: { text: 'hello' },
        index: [],
      },
      embedding,
    });

    expect(embedding.embedDocuments).not.toHaveBeenCalled();
  });

  it('should not generate embeddings when no embedding service provided', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    ddbDocMock.onAnyCommand().resolvesOnce({});

    await putOperationAction({
      client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['namespace'],
        key: 'key1',
        value: { text: 'hello' },
        index: ['$.text'],
      },
    });

    expect(ddbDocMock.calls()).toHaveLength(1);
  });

  it('should throw error for invalid user_id', async () => {
    const { client } = createMockDynamoDBClient();

    await expect(
      putOperationAction({
        client,
        memoryTableName: 'memory',
        userId: '',
        op: {
          namespace: ['namespace'],
          key: 'key1',
          value: { data: 'value' },
        },
      }),
    ).rejects.toThrow('User ID cannot be empty');
  });

  it('should throw error for invalid namespace', async () => {
    const { client } = createMockDynamoDBClient();

    await expect(
      putOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          namespace: [],
          key: 'key1',
          value: { data: 'value' },
        },
      }),
    ).rejects.toThrow('Namespace cannot be empty');
  });

  it('should throw error for invalid key', async () => {
    const { client } = createMockDynamoDBClient();

    await expect(
      putOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          namespace: ['namespace'],
          key: '',
          value: { data: 'value' },
        },
      }),
    ).rejects.toThrow('Key cannot be empty');
  });

  it('should throw error for undefined value', async () => {
    const { client } = createMockDynamoDBClient();

    await expect(
      putOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          namespace: ['namespace'],
          key: 'key1',
          value: undefined as any,
        },
      }),
    ).rejects.toThrow('Value cannot be undefined');
  });

  it('should throw error for invalid TTL', async () => {
    const { client } = createMockDynamoDBClient();

    await expect(
      putOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          namespace: ['namespace'],
          key: 'key1',
          value: { data: 'value' },
        },
        ttlDays: 0,
      }),
    ).rejects.toThrow('TTL days must be positive');
  });

  it('should throw error for invalid JSONPath', async () => {
    const { client } = createMockDynamoDBClient();
    const embedding = createMockEmbedding();

    await expect(
      putOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          namespace: ['namespace'],
          key: 'key1',
          value: { data: 'value' },
          index: ['$.__proto__.field'],
        },
        embedding,
      }),
    ).rejects.toThrow('JSONPath expression contains disallowed patterns');
  });

  it('should validate embeddings dimensions', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();
    const largeEmbedding = Array(10001).fill(1);
    const embedding = {
      embedDocuments: jest.fn(async () => [[...largeEmbedding]]),
    } as any;

    ddbDocMock.onAnyCommand().resolvesOnce({});

    await expect(
      putOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          namespace: ['namespace'],
          key: 'key1',
          value: { text: 'hello' },
          index: ['$.text'],
        },
        embedding,
      }),
    ).rejects.toThrow('Embedding dimensions');
  });

  it('should handle DynamoDB errors with retry', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    // First attempt fails, second succeeds
    ddbDocMock.reset();
    const error = new Error('Throttling error');
    error.name = 'ThrottlingException';
    ddbDocMock.onAnyCommand().rejectsOnce(error);
    ddbDocMock.onAnyCommand().resolves({});

    await putOperationAction({
      client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['namespace'],
        key: 'key1',
        value: { data: 'value' },
      },
    });

    expect(ddbDocMock.calls()).toHaveLength(2);
  });

  it('should handle nested namespaces', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    ddbDocMock.onAnyCommand().resolvesOnce({});

    await putOperationAction({
      client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['level1', 'level2', 'level3'],
        key: 'key1',
        value: { data: 'value' },
      },
    });

    expect(ddbDocMock.calls()).toHaveLength(1);
  });
});
