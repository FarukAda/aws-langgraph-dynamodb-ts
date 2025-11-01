import { putOperationAction } from '../../../src/store/actions';
import {
  setupStoreTest,
  setupStoreTestWithEmbedding,
  type StoreTestSetup,
} from '../../shared/helpers/test-setup';
import { expectDynamoDBCalled } from '../../shared/helpers/assertions';
import { createMockEmbedding } from '../../shared/mocks/embedding-mock';

describe('putOperationAction', () => {
  let setup: StoreTestSetup;

  beforeEach(() => {
    setup = setupStoreTest();
  });

  afterEach(() => {
    setup.cleanup();
  });

  it('should put item without embeddings', async () => {
    setup.ddbDocMock.onAnyCommand().resolvesOnce({});

    await putOperationAction({
      client: setup.client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['namespace'],
        key: 'key1',
        value: { data: 'value' },
      },
    });

    expectDynamoDBCalled(setup.ddbDocMock, 1);
  });

  it('should put item with embeddings', async () => {
    const embeddingSetup = setupStoreTestWithEmbedding();
    embeddingSetup.ddbDocMock.onAnyCommand().resolvesOnce({});

    await putOperationAction({
      client: embeddingSetup.client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['namespace'],
        key: 'key1',
        value: { text: 'hello world' },
        index: ['$.text'],
      },
      embedding: embeddingSetup.embedding,
    });

    expect(embeddingSetup.embedding.embedDocuments).toHaveBeenCalledWith(['hello world']);
    expectDynamoDBCalled(embeddingSetup.ddbDocMock, 1);
    embeddingSetup.cleanup();
  });

  it('should put item with TTL', async () => {
    setup.ddbDocMock.onAnyCommand().resolvesOnce({});

    await putOperationAction({
      client: setup.client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['namespace'],
        key: 'key1',
        value: { data: 'value' },
      },
      ttlDays: 30,
    });

    expectDynamoDBCalled(setup.ddbDocMock, 1);
  });

  it('should extract string values from JSONPath', async () => {
    const embeddingSetup = setupStoreTestWithEmbedding();
    embeddingSetup.ddbDocMock.onAnyCommand().resolvesOnce({});

    await putOperationAction({
      client: embeddingSetup.client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['namespace'],
        key: 'key1',
        value: { title: 'Hello', description: 'World' },
        index: ['$.title', '$.description'],
      },
      embedding: embeddingSetup.embedding,
    });

    expect(embeddingSetup.embedding.embedDocuments).toHaveBeenCalledWith(['Hello', 'World']);
    embeddingSetup.cleanup();
  });

  it('should extract number values from JSONPath', async () => {
    const embeddingSetup = setupStoreTestWithEmbedding();
    embeddingSetup.ddbDocMock.onAnyCommand().resolvesOnce({});

    await putOperationAction({
      client: embeddingSetup.client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['namespace'],
        key: 'key1',
        value: { count: 42 },
        index: ['$.count'],
      },
      embedding: embeddingSetup.embedding,
    });

    expect(embeddingSetup.embedding.embedDocuments).toHaveBeenCalledWith(['42']);
    embeddingSetup.cleanup();
  });

  it('should extract boolean values from JSONPath', async () => {
    const embeddingSetup = setupStoreTestWithEmbedding();
    embeddingSetup.ddbDocMock.onAnyCommand().resolvesOnce({});

    await putOperationAction({
      client: embeddingSetup.client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['namespace'],
        key: 'key1',
        value: { active: true },
        index: ['$.active'],
      },
      embedding: embeddingSetup.embedding,
    });

    expect(embeddingSetup.embedding.embedDocuments).toHaveBeenCalledWith(['true']);
    embeddingSetup.cleanup();
  });

  it('should stringify object values from JSONPath', async () => {
    const embeddingSetup = setupStoreTestWithEmbedding();
    embeddingSetup.ddbDocMock.onAnyCommand().resolvesOnce({});

    await putOperationAction({
      client: embeddingSetup.client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['namespace'],
        key: 'key1',
        value: { user: { name: 'John', age: 30 } },
        index: ['$.user'],
      },
      embedding: embeddingSetup.embedding,
    });

    expect(embeddingSetup.embedding.embedDocuments).toHaveBeenCalledWith([
      JSON.stringify({ name: 'John', age: 30 }),
    ]);
    embeddingSetup.cleanup();
  });

  it('should skip null and undefined values from JSONPath', async () => {
    const embeddingSetup = setupStoreTestWithEmbedding();
    embeddingSetup.ddbDocMock.onAnyCommand().resolvesOnce({});

    await putOperationAction({
      client: embeddingSetup.client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['namespace'],
        key: 'key1',
        value: { text: 'hello', empty: null, missing: undefined },
        index: ['$.text', '$.empty', '$.missing'],
      },
      embedding: embeddingSetup.embedding,
    });

    expect(embeddingSetup.embedding.embedDocuments).toHaveBeenCalledWith(['hello']);
    embeddingSetup.cleanup();
  });

  it('should not generate embeddings when no index provided', async () => {
    const embedding = createMockEmbedding();
    setup.ddbDocMock.onAnyCommand().resolvesOnce({});

    await putOperationAction({
      client: setup.client,
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
    const embedding = createMockEmbedding();
    setup.ddbDocMock.onAnyCommand().resolvesOnce({});

    await putOperationAction({
      client: setup.client,
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
    setup.ddbDocMock.onAnyCommand().resolvesOnce({});

    await putOperationAction({
      client: setup.client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['namespace'],
        key: 'key1',
        value: { text: 'hello' },
        index: ['$.text'],
      },
    });

    expectDynamoDBCalled(setup.ddbDocMock, 1);
  });

  describe('validation errors', () => {
    it.each([
      {
        description: 'invalid user_id',
        params: {
          userId: '',
          op: { namespace: ['namespace'], key: 'key1', value: { data: 'value' } },
        },
        expectedError: 'User ID cannot be empty',
      },
      {
        description: 'invalid namespace',
        params: {
          userId: 'user-123',
          op: { namespace: [], key: 'key1', value: { data: 'value' } },
        },
        expectedError: 'Namespace cannot be empty',
      },
      {
        description: 'invalid key',
        params: {
          userId: 'user-123',
          op: { namespace: ['namespace'], key: '', value: { data: 'value' } },
        },
        expectedError: 'Key cannot be empty',
      },
      {
        description: 'undefined value',
        params: {
          userId: 'user-123',
          op: { namespace: ['namespace'], key: 'key1', value: undefined as any },
        },
        expectedError: 'Value cannot be undefined',
      },
      {
        description: 'invalid TTL',
        params: {
          userId: 'user-123',
          op: { namespace: ['namespace'], key: 'key1', value: { data: 'value' } },
          ttlDays: 0,
        },
        expectedError: 'TTL days must be positive',
      },
    ])('should throw error for $description', async ({ params, expectedError }) => {
      await expect(
        putOperationAction({
          client: setup.client,
          memoryTableName: 'memory',
          ...params,
        }),
      ).rejects.toThrow(expectedError);
    });
  });

  it('should throw error for invalid JSONPath', async () => {
    const embedding = createMockEmbedding();

    await expect(
      putOperationAction({
        client: setup.client,
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
    setup.ddbDocMock.onAnyCommand().resolvesOnce({});
    const largeEmbedding = Array(10001).fill(1);
    const embedding = {
      embedDocuments: jest.fn(async () => [[...largeEmbedding]]),
    } as any;

    await expect(
      putOperationAction({
        client: setup.client,
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
    // First attempt fails, second succeeds
    setup.ddbDocMock.reset();
    const error = new Error('Throttling error');
    error.name = 'ThrottlingException';
    setup.ddbDocMock.onAnyCommand().rejectsOnce(error);
    setup.ddbDocMock.onAnyCommand().resolves({});

    await putOperationAction({
      client: setup.client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['namespace'],
        key: 'key1',
        value: { data: 'value' },
      },
    });

    expectDynamoDBCalled(setup.ddbDocMock, 2);
  });

  it('should handle nested namespaces', async () => {
    setup.ddbDocMock.onAnyCommand().resolvesOnce({});

    await putOperationAction({
      client: setup.client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['level1', 'level2', 'level3'],
        key: 'key1',
        value: { data: 'value' },
      },
    });

    expectDynamoDBCalled(setup.ddbDocMock, 1);
  });
});
