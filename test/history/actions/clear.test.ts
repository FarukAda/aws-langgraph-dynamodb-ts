import { clearAction } from '../../../src/history/actions';
import { createMockDynamoDBClient } from '../../shared/mocks/dynamodb-mock';

describe('clearAction', () => {
  it('should delete session successfully', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    ddbDocMock.onAnyCommand().resolvesOnce({});

    await clearAction({
      client,
      tableName: 'history',
      userId: 'user-123',
      sessionId: 'session-1',
    });

    expect(ddbDocMock.calls()).toHaveLength(1);
  });

  it('should not throw error when session does not exist', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    ddbDocMock.onAnyCommand().resolvesOnce({});

    await expect(
      clearAction({
        client,
        tableName: 'history',
        userId: 'user-123',
        sessionId: 'non-existent',
      }),
    ).resolves.not.toThrow();
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
});
