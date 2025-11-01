import { getMessagesAction } from '../../../src/history/actions';
import { createMockDynamoDBClient } from '../../shared/mocks/dynamodb-mock';
import { createMockSessionItem, createMockMessage } from '../../shared/fixtures/test-data';

describe('getMessagesAction', () => {
  it('should get messages successfully', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    const messages = [createMockMessage('Hello'), createMockMessage('Hi', 'ai')];
    const sessionItem = createMockSessionItem('user-123', 'session-1', messages);

    ddbDocMock.onAnyCommand().resolvesOnce({
      Item: sessionItem,
    });

    const result = await getMessagesAction({
      client,
      tableName: 'history',
      userId: 'user-123',
      sessionId: 'session-1',
    });

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('Hello');
    expect(result[1].content).toBe('Hi');
  });

  it('should return empty array when session not found', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    ddbDocMock.onAnyCommand().resolvesOnce({});

    const result = await getMessagesAction({
      client,
      tableName: 'history',
      userId: 'user-123',
      sessionId: 'non-existent',
    });

    expect(result).toEqual([]);
  });

  it('should return empty array when messages field is missing', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    ddbDocMock.onAnyCommand().resolvesOnce({
      Item: {
        userId: 'user-123',
        sessionId: 'session-1',
      },
    });

    const result = await getMessagesAction({
      client,
      tableName: 'history',
      userId: 'user-123',
      sessionId: 'session-1',
    });

    expect(result).toEqual([]);
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

  it('should throw error for invalid session ID', async () => {
    const { client } = createMockDynamoDBClient();

    await expect(
      getMessagesAction({
        client,
        tableName: 'history',
        userId: 'user-123',
        sessionId: '',
      }),
    ).rejects.toThrow('Session ID cannot be empty');
  });
});
