import { addMessagesAction } from '../../../src/history/actions';
import { createMockMessage } from '../../shared/fixtures/test-data';
import { createMockDynamoDBClient } from '../../shared/mocks/dynamodb-mock';

describe('addMessagesAction', () => {
  describe('atomic counter + transactWrite path', () => {
    it('should add multiple messages to new session with auto-generated title', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      // Mock atomic counter update (claims 2 indices) + transactWrite for messages
      ddbDocMock
        .onAnyCommand()
        .resolvesOnce({ Attributes: { messageCount: 2 } })
        .resolvesOnce({});

      const messages = [createMockMessage('Hello'), createMockMessage('Hi', 'ai')];

      await addMessagesAction({
        client,
        tableName: 'history',
        userId: 'user-123',
        sessionId: 'session-1',
        messages,
      });

      // 1 update (atomic counter) + 1 transactWrite = 2 calls
      expect(ddbDocMock.calls()).toHaveLength(2);
    });

    it('should add multiple messages to existing session', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      // Atomic counter returns 3 (was 1, added 2)
      ddbDocMock
        .onAnyCommand()
        .resolvesOnce({ Attributes: { messageCount: 3 } })
        .resolvesOnce({});

      const messages = [createMockMessage('New 1'), createMockMessage('New 2')];

      await addMessagesAction({
        client,
        tableName: 'history',
        userId: 'user-123',
        sessionId: 'session-1',
        messages,
      });

      // 1 update + 1 transactWrite = 2 calls
      expect(ddbDocMock.calls()).toHaveLength(2);
    });

    it('should add messages to new session with provided title', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      ddbDocMock
        .onAnyCommand()
        .resolvesOnce({ Attributes: { messageCount: 2 } })
        .resolvesOnce({});

      const messages = [createMockMessage('Hello'), createMockMessage('Hi', 'ai')];

      await addMessagesAction({
        client,
        tableName: 'history',
        userId: 'user-123',
        sessionId: 'session-1',
        messages,
        title: 'Custom Title',
      });

      // 1 update + 1 transactWrite = 2 calls
      expect(ddbDocMock.calls()).toHaveLength(2);
    });

    it('should add messages to new session with TTL', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      ddbDocMock
        .onAnyCommand()
        .resolvesOnce({ Attributes: { messageCount: 2 } })
        .resolvesOnce({});

      const messages = [createMockMessage('Message 1'), createMockMessage('Message 2')];

      await addMessagesAction({
        client,
        tableName: 'history',
        userId: 'user-123',
        sessionId: 'session-1',
        messages,
        ttlDays: 7,
      });

      // 1 update + 1 transactWrite = 2 calls
      expect(ddbDocMock.calls()).toHaveLength(2);
    });

    it('should add messages to existing session with TTL', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      ddbDocMock
        .onAnyCommand()
        .resolvesOnce({ Attributes: { messageCount: 3 } })
        .resolvesOnce({});

      const messages = [createMockMessage('New 1'), createMockMessage('New 2')];

      await addMessagesAction({
        client,
        tableName: 'history',
        userId: 'user-123',
        sessionId: 'session-1',
        messages,
        ttlDays: 30,
      });

      // 1 update + 1 transactWrite = 2 calls
      expect(ddbDocMock.calls()).toHaveLength(2);
    });

    it('should handle max batch size (100 messages)', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      ddbDocMock
        .onAnyCommand()
        .resolvesOnce({ Attributes: { messageCount: 100 } })
        .resolvesOnce({});

      const messages = Array(100)
        .fill(null)
        .map((_, i) => createMockMessage(`Message ${i}`));

      await addMessagesAction({
        client,
        tableName: 'history',
        userId: 'user-123',
        sessionId: 'session-1',
        messages,
      });

      // 1 update + 1 transactWrite = 2 calls
      expect(ddbDocMock.calls()).toHaveLength(2);
    });
  });

  describe('validation errors', () => {
    it('should throw error for empty messages array', async () => {
      const { client } = createMockDynamoDBClient();

      await expect(
        addMessagesAction({
          client,
          tableName: 'history',
          userId: 'user-123',
          sessionId: 'session-1',
          messages: [],
        }),
      ).rejects.toThrow('Messages array cannot be empty');
    });

    it('should throw error for invalid message in array', async () => {
      const { client } = createMockDynamoDBClient();

      await expect(
        addMessagesAction({
          client,
          tableName: 'history',
          userId: 'user-123',
          sessionId: 'session-1',
          messages: [createMockMessage('Valid'), null as any],
        }),
      ).rejects.toThrow('Invalid message at index 1');
    });

    it('should throw error for too many messages', async () => {
      const { client } = createMockDynamoDBClient();

      const manyMessages = Array(101)
        .fill(null)
        .map((_, i) => createMockMessage(`Message ${i}`));

      await expect(
        addMessagesAction({
          client,
          tableName: 'history',
          userId: 'user-123',
          sessionId: 'session-1',
          messages: manyMessages,
        }),
      ).rejects.toThrow('exceeds maximum of 100');
    });
  });
});
