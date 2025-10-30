import { getOperationAction } from '../../../src/store/actions/get-operation';
import { createMockDynamoDBClient } from '../../shared/mocks/dynamodb-mock';
import { createMockStoreItem } from '../../shared/fixtures/test-data';

describe('getOperationAction', () => {
  it('should get item successfully', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    const item = createMockStoreItem('user-123', ['namespace'], 'key1', { data: 'value' });

    ddbDocMock.onAnyCommand().resolvesOnce({
      Item: item,
    });

    const result = await getOperationAction({
      client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['namespace'],
        key: 'key1',
      },
    });

    expect(result).toBeDefined();
    expect(result!.key).toBe('key1');
    expect(result!.namespace).toEqual(['namespace']);
    expect(result!.value).toEqual({ data: 'value' });
  });

  it('should return null when item not found', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    ddbDocMock.onAnyCommand().resolvesOnce({});

    const result = await getOperationAction({
      client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['namespace'],
        key: 'non-existent',
      },
    });

    expect(result).toBeNull();
  });

  it('should construct correct composite key', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    const item = createMockStoreItem('user-123', ['level1', 'level2'], 'key1', { data: 'value' });

    ddbDocMock.onAnyCommand().resolvesOnce({
      Item: item,
    });

    const result = await getOperationAction({
      client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['level1', 'level2'],
        key: 'key1',
      },
    });

    expect(result).toBeDefined();
    expect(result!.namespace).toEqual(['level1', 'level2']);
  });

  it('should throw error for invalid user_id', async () => {
    const { client } = createMockDynamoDBClient();

    await expect(
      getOperationAction({
        client,
        memoryTableName: 'memory',
        userId: '',
        op: {
          namespace: ['namespace'],
          key: 'key1',
        },
      }),
    ).rejects.toThrow('User ID cannot be empty');
  });

  it('should throw error for invalid namespace', async () => {
    const { client } = createMockDynamoDBClient();

    await expect(
      getOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          namespace: [],
          key: 'key1',
        },
      }),
    ).rejects.toThrow('Namespace cannot be empty');
  });

  it('should throw error for invalid key', async () => {
    const { client } = createMockDynamoDBClient();

    await expect(
      getOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          namespace: ['namespace'],
          key: '',
        },
      }),
    ).rejects.toThrow('Key cannot be empty');
  });

  it('should throw error for namespace with # character', async () => {
    const { client } = createMockDynamoDBClient();

    await expect(
      getOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          namespace: ['namespace#invalid'],
          key: 'key1',
        },
      }),
    ).rejects.toThrow('Namespace parts cannot contain "#" character');
  });

  it('should throw error for key with # character', async () => {
    const { client } = createMockDynamoDBClient();

    await expect(
      getOperationAction({
        client,
        memoryTableName: 'memory',
        userId: 'user-123',
        op: {
          namespace: ['namespace'],
          key: 'key#invalid',
        },
      }),
    ).rejects.toThrow('Key cannot contain "#" character');
  });

  it('should handle DynamoDB errors with retry', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    const item = createMockStoreItem('user-123', ['namespace'], 'key1', { data: 'value' });

    // First attempt fails, second succeeds
    ddbDocMock.reset();
    const error = new Error('Throttling error');
    error.name = 'ThrottlingException';
    ddbDocMock.onAnyCommand().rejectsOnce(error);
    ddbDocMock.onAnyCommand().resolves({
      Item: item,
    });

    const result = await getOperationAction({
      client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['namespace'],
        key: 'key1',
      },
    });

    expect(result).toBeDefined();
    expect(ddbDocMock.calls()).toHaveLength(2);
  });

  it('should return item with all fields', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    const now = Date.now();
    const item = {
      user_id: 'user-123',
      namespace_key: 'namespace#key1',
      namespace: 'namespace',
      key: 'key1',
      value: { data: 'value', nested: { field: 'test' } },
      createdAt: now - 1000,
      updatedAt: now,
    };

    ddbDocMock.onAnyCommand().resolvesOnce({
      Item: item,
    });

    const result = await getOperationAction({
      client,
      memoryTableName: 'memory',
      userId: 'user-123',
      op: {
        namespace: ['namespace'],
        key: 'key1',
      },
    });

    expect(result).toBeDefined();
    expect(result!.key).toBe('key1');
    expect(result!.value).toEqual({ data: 'value', nested: { field: 'test' } });
    expect(result!.createdAt).toBe(now - 1000);
    expect(result!.updatedAt).toBe(now);
  });
});
