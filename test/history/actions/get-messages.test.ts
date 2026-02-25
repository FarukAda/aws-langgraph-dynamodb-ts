import { getMessagesAction } from '../../../src/history/actions';
import { createMockStoredMessage } from '../../shared/fixtures/test-data';
import { createMockDynamoDBClient } from '../../shared/mocks/dynamodb-mock';

describe('getMessagesAction', () => {
  it('should get messages successfully', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    // Mock query returning individual message items
    ddbDocMock.onAnyCommand().resolvesOnce({
      Items: [
        {
          userId: 'user-123',
          sessionId: 'session-1#msg#000000',
          itemType: 'message',
          messageIndex: 0,
          message: createMockStoredMessage('Hello'),
        },
        {
          userId: 'user-123',
          sessionId: 'session-1#msg#000001',
          itemType: 'message',
          messageIndex: 1,
          message: createMockStoredMessage('Hi', 'ai'),
        },
      ],
    });

    const result = await getMessagesAction({
      client,
      tableName: 'history',
      userId: 'user-123',
      sessionId: 'session-1',
    });

    expect(result).toHaveLength(2);
    // Verify messages are properly deserialized BaseMessage instances
    expect(result[0].content).toBe('Hello');
    expect(result[1].content).toBe('Hi');
  });

  it('should return empty array for non-existent session', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    ddbDocMock.onAnyCommand().resolvesOnce({ Items: [] });

    const result = await getMessagesAction({
      client,
      tableName: 'history',
      userId: 'user-123',
      sessionId: 'nonexistent',
    });

    expect(result).toEqual([]);
  });

  it('should return messages in chronological order', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    // Return items out of order to verify sorting
    ddbDocMock.onAnyCommand().resolvesOnce({
      Items: [
        {
          userId: 'user-123',
          sessionId: 'session-1#msg#000002',
          itemType: 'message',
          messageIndex: 2,
          message: createMockStoredMessage('Third'),
        },
        {
          userId: 'user-123',
          sessionId: 'session-1#msg#000000',
          itemType: 'message',
          messageIndex: 0,
          message: createMockStoredMessage('First'),
        },
        {
          userId: 'user-123',
          sessionId: 'session-1#msg#000001',
          itemType: 'message',
          messageIndex: 1,
          message: createMockStoredMessage('Second', 'ai'),
        },
      ],
    });

    const result = await getMessagesAction({
      client,
      tableName: 'history',
      userId: 'user-123',
      sessionId: 'session-1',
    });

    expect(result).toHaveLength(3);
    expect(result[0].content).toBe('First');
    expect(result[1].content).toBe('Second');
    expect(result[2].content).toBe('Third');
  });

  it('should throw error for invalid user ID', async () => {
    const { client } = createMockDynamoDBClient();

    await expect(
      getMessagesAction({
        client,
        tableName: 'history',
        userId: '',
        sessionId: 'session-1',
      }),
    ).rejects.toThrow('User ID cannot be empty');
  });

  it('should handle paginated results', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    // First page then second page (chained for sequential resolution)
    ddbDocMock
      .onAnyCommand()
      .resolvesOnce({
        Items: [
          {
            userId: 'user-123',
            sessionId: 'session-1#msg#000000',
            itemType: 'message',
            messageIndex: 0,
            message: createMockStoredMessage('First'),
          },
        ],
        LastEvaluatedKey: { userId: 'user-123', sessionId: 'session-1#msg#000000' },
      })
      .resolvesOnce({
        Items: [
          {
            userId: 'user-123',
            sessionId: 'session-1#msg#000001',
            itemType: 'message',
            messageIndex: 1,
            message: createMockStoredMessage('Second', 'ai'),
          },
        ],
      });

    const result = await getMessagesAction({
      client,
      tableName: 'history',
      userId: 'user-123',
      sessionId: 'session-1',
    });

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('First');
    expect(result[1].content).toBe('Second');
  });

  it('should throw when exceeding maximum loop iterations', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    // Every call returns a page with LastEvaluatedKey, creating an infinite loop
    ddbDocMock.onAnyCommand().resolves({
      Items: [
        {
          userId: 'user-123',
          sessionId: 'session-1#msg#000000',
          itemType: 'message',
          messageIndex: 0,
          message: createMockStoredMessage('Msg'),
        },
      ],
      LastEvaluatedKey: { userId: 'user-123', sessionId: 'session-1#msg#000000' },
    });

    await expect(
      getMessagesAction({
        client,
        tableName: 'history',
        userId: 'user-123',
        sessionId: 'session-1',
      }),
    ).rejects.toThrow('exceeded maximum iteration limit');
  });
});
