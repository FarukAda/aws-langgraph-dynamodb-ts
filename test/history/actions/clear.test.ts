import { clearAction } from '../../../src/history/actions';
import { createMockDynamoDBClient } from '../../shared/mocks/dynamodb-mock';

describe('clearAction', () => {
  it('should delete session and all messages successfully', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    // Mock query for message items (returns 2 messages)
    ddbDocMock
      .onAnyCommand()
      .resolvesOnce({
        Items: [
          { userId: 'user-123', sessionId: 'session-1#msg#000000' },
          { userId: 'user-123', sessionId: 'session-1#msg#000001' },
        ],
      })
      // Mock batchWrite delete (metadata + 2 messages = 3 items) - no UnprocessedItems
      .resolvesOnce({});

    await clearAction({
      client,
      tableName: 'history',
      userId: 'user-123',
      sessionId: 'session-1',
    });

    // 1 query + 1 batchWrite = 2 calls
    expect(ddbDocMock.calls()).toHaveLength(2);
  });

  it('should retry UnprocessedItems from batchWrite delete', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    // Mock query for message items
    ddbDocMock
      .onAnyCommand()
      .resolvesOnce({
        Items: [
          { userId: 'user-123', sessionId: 'session-1#msg#000000' },
          { userId: 'user-123', sessionId: 'session-1#msg#000001' },
        ],
      })
      // Mock batchWrite - returns UnprocessedItems
      .resolvesOnce({
        UnprocessedItems: {
          history: [
            { DeleteRequest: { Key: { userId: 'user-123', sessionId: 'session-1#msg#000001' } } },
          ],
        },
      })
      // Mock retry of unprocessed items - succeeds
      .resolvesOnce({});

    await clearAction({
      client,
      tableName: 'history',
      userId: 'user-123',
      sessionId: 'session-1',
    });

    // 1 query + 1 batchWrite + 1 retry = 3 calls
    expect(ddbDocMock.calls()).toHaveLength(3);
  });

  it('should not throw error when session does not exist', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    // No message items found
    ddbDocMock
      .onAnyCommand()
      .resolvesOnce({ Items: [] })
      // Still deletes the metadata key (no-op if not there)
      .resolvesOnce({});

    await expect(
      clearAction({
        client,
        tableName: 'history',
        userId: 'user-123',
        sessionId: 'non-existent',
      }),
    ).resolves.not.toThrow();
  });

  it('should throw after exceeding max UnprocessedItems retries', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    // Every batchWrite returns UnprocessedItems indefinitely
    const unprocessedResponse = {
      UnprocessedItems: {
        history: [
          { DeleteRequest: { Key: { userId: 'user-123', sessionId: 'session-1#msg#000001' } } },
        ],
      },
    };

    // Mock query returning 2 message items, then every subsequent call returns unprocessed
    ddbDocMock
      .onAnyCommand()
      .resolvesOnce({
        Items: [
          { userId: 'user-123', sessionId: 'session-1#msg#000000' },
          { userId: 'user-123', sessionId: 'session-1#msg#000001' },
        ],
      })
      .resolves(unprocessedResponse);

    await expect(
      clearAction({
        client,
        tableName: 'history',
        userId: 'user-123',
        sessionId: 'session-1',
      }),
    ).rejects.toThrow(/batchWrite did not drain after 10 UnprocessedItems retries/);
  });

  it('should throw error for invalid user ID', async () => {
    const { client } = createMockDynamoDBClient();

    await expect(
      clearAction({
        client,
        tableName: 'history',
        userId: '',
        sessionId: 'session-1',
      }),
    ).rejects.toThrow('User ID cannot be empty');
  });

  it('should throw error for invalid session ID', async () => {
    const { client } = createMockDynamoDBClient();

    await expect(
      clearAction({
        client,
        tableName: 'history',
        userId: 'user-123',
        sessionId: '',
      }),
    ).rejects.toThrow('Session ID cannot be empty');
  });

  it('should throw when exceeding maximum loop iterations', async () => {
    const { client, ddbDocMock } = createMockDynamoDBClient();

    // Every query returns items with LastEvaluatedKey, creating an infinite loop
    ddbDocMock.onAnyCommand().resolves({
      Items: [{ userId: 'user-123', sessionId: 'session-1#msg#000000' }],
      LastEvaluatedKey: { userId: 'user-123', sessionId: 'session-1#msg#000000' },
    });

    await expect(
      clearAction({
        client,
        tableName: 'history',
        userId: 'user-123',
        sessionId: 'session-1',
      }),
    ).rejects.toThrow('exceeded maximum iteration limit');
  });
});
