import { batchWriteWithRetry, batchWriteAllWithRetry } from '../../../src/shared/utils/batch-write';
import { createMockDynamoDBClient } from '../mocks/dynamodb-mock';

describe('batchWriteWithRetry', () => {
  it('should execute a batch write successfully with no unprocessed items', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    ddbDocMock.onAnyCommand().resolvesOnce({});

    const requestItems = [
      { PutRequest: { Item: { userId: 'user-1', data: 'value' } } },
      { PutRequest: { Item: { userId: 'user-2', data: 'value' } } },
    ];

    await batchWriteWithRetry(client, 'test-table', requestItems);

    expect(ddbDocMock.calls()).toHaveLength(1);
  });

  it('should do nothing for empty items array', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    await batchWriteWithRetry(client, 'test-table', []);

    expect(ddbDocMock.calls()).toHaveLength(0);
  });

  it('should retry unprocessed items with backoff', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    ddbDocMock
      .onAnyCommand()
      .resolvesOnce({
        UnprocessedItems: {
          'test-table': [{ PutRequest: { Item: { userId: 'user-1' } } }],
        },
      })
      .resolvesOnce({});

    const requestItems = [{ PutRequest: { Item: { userId: 'user-1', data: 'value' } } }];

    await batchWriteWithRetry(client, 'test-table', requestItems);

    // 1 initial + 1 retry = 2 calls
    expect(ddbDocMock.calls()).toHaveLength(2);
  });

  it('should throw after exceeding max retries', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    const unprocessedResponse = {
      UnprocessedItems: {
        'test-table': [{ PutRequest: { Item: { userId: 'user-1' } } }],
      },
    };

    // Every call returns unprocessed items
    ddbDocMock.onAnyCommand().resolves(unprocessedResponse);

    const requestItems = [{ PutRequest: { Item: { userId: 'user-1', data: 'value' } } }];

    await expect(batchWriteWithRetry(client, 'test-table', requestItems)).rejects.toThrow(
      /batchWrite did not drain after 10 UnprocessedItems retries/,
    );
  });

  it('should surface unprocessed items on an exhaustion error for reconciliation', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    const unprocessed = [{ PutRequest: { Item: { userId: 'user-1' } } }];
    ddbDocMock.onAnyCommand().resolves({
      UnprocessedItems: { 'test-table': unprocessed },
    });

    const initial = [
      { PutRequest: { Item: { userId: 'user-1', data: 'A' } } },
      { PutRequest: { Item: { userId: 'user-2', data: 'B' } } },
    ];

    try {
      await batchWriteWithRetry(client, 'test-table', initial);
      fail('expected batchWriteWithRetry to throw');
    } catch (err: any) {
      expect(err.name).toBe('BatchWriteIncompleteError');
      expect(err.unprocessed).toHaveLength(1);
      // DynamoDB acked 2 - 1 = 1 item before we gave up.
      expect(err.succeededCount).toBe(1);
    }
  });
});

describe('batchWriteAllWithRetry', () => {
  it('should chunk items into batches of 25', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    ddbDocMock.onAnyCommand().resolves({});

    const requestItems = Array(30)
      .fill(null)
      .map((_, i) => ({
        PutRequest: { Item: { userId: `user-${i}`, data: 'value' } },
      }));

    await batchWriteAllWithRetry(client, 'test-table', requestItems);

    // 25 + 5 = 2 batch writes
    expect(ddbDocMock.calls()).toHaveLength(2);
  });

  it('should do nothing for empty items array', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    await batchWriteAllWithRetry(client, 'test-table', []);

    expect(ddbDocMock.calls()).toHaveLength(0);
  });

  it('should handle delete requests', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    ddbDocMock.onAnyCommand().resolvesOnce({});

    const requestItems = [
      { DeleteRequest: { Key: { userId: 'user-1', sessionId: 'session-1' } } },
      { DeleteRequest: { Key: { userId: 'user-2', sessionId: 'session-2' } } },
    ];

    await batchWriteAllWithRetry(client, 'test-table', requestItems);

    expect(ddbDocMock.calls()).toHaveLength(1);
  });
});
