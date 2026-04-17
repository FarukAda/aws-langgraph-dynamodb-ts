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

    it('should handle max batch size (99 messages — leaves room for metadata in 100-item txn)', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      ddbDocMock.onAnyCommand().resolvesOnce({}).resolvesOnce({});

      const messages = Array(99)
        .fill(null)
        .map((_, i) => createMockMessage(`Message ${i}`));

      await addMessagesAction({
        client,
        tableName: 'history',
        userId: 'user-123',
        sessionId: 'session-1',
        messages,
      });

      // 1 get + 1 transactWrite = 2 calls
      expect(ddbDocMock.calls()).toHaveLength(2);
    });

    it('regression: TransactWrite failure leaves no orphaned counter', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      // First get: returns existing count of 5.
      // transactWrite: rejects with a non-conditional error (e.g. network failure).
      ddbDocMock
        .onAnyCommand()
        .resolvesOnce({ Item: { messageCount: 5 } })
        .rejectsOnce(new Error('network'));

      await expect(
        addMessagesAction({
          client,
          tableName: 'history',
          userId: 'user-123',
          sessionId: 'session-1',
          messages: [createMockMessage('A'), createMockMessage('B')],
        }),
      ).rejects.toThrow('network');

      // Only the read + the failed transactWrite — no standalone counter update.
      expect(ddbDocMock.calls()).toHaveLength(2);
    });

    it('retries on ConditionalCheckFailed and succeeds', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      const ccfError: any = new Error('concurrency');
      ccfError.name = 'TransactionCanceledException';
      ccfError.CancellationReasons = [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }];

      ddbDocMock
        .onAnyCommand()
        .resolvesOnce({ Item: { messageCount: 5 } }) // first get
        .rejectsOnce(ccfError) // first transactWrite fails
        .resolvesOnce({ Item: { messageCount: 7 } }) // re-read picks up newer count
        .resolvesOnce({}); // second transactWrite succeeds

      await addMessagesAction({
        client,
        tableName: 'history',
        userId: 'user-123',
        sessionId: 'session-1',
        messages: [createMockMessage('A'), createMockMessage('B')],
      });

      expect(ddbDocMock.calls()).toHaveLength(4);
    });

    it('does not retry when a permanent reason is mixed with ConditionalCheckFailed', async () => {
      const { ddbDocMock, client } = createMockDynamoDBClient();

      // ValidationError and ItemCollectionSizeLimitExceeded are permanent per DDB
      // docs — retrying the whole transaction will never resolve the permanent
      // sub-reason, so the caller must see the failure, not a 5x retry loop.
      const mixedError: any = new Error('mixed');
      mixedError.name = 'TransactionCanceledException';
      mixedError.CancellationReasons = [
        { Code: 'ConditionalCheckFailed' },
        { Code: 'ValidationError' },
      ];

      ddbDocMock
        .onAnyCommand()
        .resolvesOnce({ Item: { messageCount: 5 } })
        .rejectsOnce(mixedError);

      await expect(
        addMessagesAction({
          client,
          tableName: 'history',
          userId: 'user-123',
          sessionId: 'session-1',
          messages: [createMockMessage('A')],
        }),
      ).rejects.toThrow('mixed');

      // One get + one failed transact — no re-read / retry.
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

      const manyMessages = Array(100)
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
      ).rejects.toThrow('exceeds maximum of 99');
    });
  });
});
