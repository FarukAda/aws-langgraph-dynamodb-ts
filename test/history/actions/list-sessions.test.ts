import { listSessionsAction } from '../../../src/history/actions';
import { createMockDynamoDBClient } from '../../shared/mocks/dynamodb-mock';

describe('listSessionsAction', () => {
  it('should list sessions successfully', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    const now = Date.now();
    ddbDocMock.onAnyCommand().resolvesOnce({
      Items: [
        {
          sessionId: 'session-1',
          title: 'Session 1',
          createdAt: now - 2000,
          updatedAt: now - 1000,
          messageCount: 5,
        },
        {
          sessionId: 'session-2',
          title: 'Session 2',
          createdAt: now - 1000,
          updatedAt: now,
          messageCount: 3,
        },
      ],
    });

    const result = await listSessionsAction({
      client,
      tableName: 'history',
      userId: 'user-123',
    });

    expect(result).toHaveLength(2);
    expect(result[0].sessionId).toBe('session-2'); // Most recent first
    expect(result[1].sessionId).toBe('session-1');
  });

  it('should return empty array when no sessions exist', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    ddbDocMock.onAnyCommand().resolvesOnce({
      Items: [],
    });

    const result = await listSessionsAction({
      client,
      tableName: 'history',
      userId: 'user-123',
    });

    expect(result).toEqual([]);
  });

  it('should respect limit parameter', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    ddbDocMock.onAnyCommand().resolvesOnce({
      Items: [
        {
          sessionId: 'session-1',
          title: 'Session 1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messageCount: 5,
        },
      ],
    });

    const result = await listSessionsAction({
      client,
      tableName: 'history',
      userId: 'user-123',
      limit: 10,
    });

    expect(result).toHaveLength(1);
  });

  it('should throw error for invalid user ID', async () => {
    const { client } = createMockDynamoDBClient();

    await expect(
      listSessionsAction({
        client,
        tableName: 'history',
        userId: '',
      }),
    ).rejects.toThrow('User ID cannot be empty');
  });

  it('should throw error for invalid limit', async () => {
    const { client } = createMockDynamoDBClient();

    await expect(
      listSessionsAction({
        client,
        tableName: 'history',
        userId: 'user-123',
        limit: -1,
      }),
    ).rejects.toThrow('Limit must be positive');
  });

  it('should throw error for limit exceeding maximum', async () => {
    const { client } = createMockDynamoDBClient();

    await expect(
      listSessionsAction({
        client,
        tableName: 'history',
        userId: 'user-123',
        limit: 1001,
      }),
    ).rejects.toThrow('Limit cannot exceed 1000');
  });
});
