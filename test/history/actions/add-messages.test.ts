import { addMessagesAction } from '../../../src/history/actions';
import { createMockDynamoDBClient } from '../../shared/mocks/dynamodb-mock';
import { createMockMessage } from '../../shared/fixtures/test-data';

describe('addMessagesAction', () => {
  it('should add multiple messages to new session with auto-generated title', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    ddbDocMock.onAnyCommand().resolvesOnce({});
    ddbDocMock.onAnyCommand().resolvesOnce({});

    const messages = [createMockMessage('Hello'), createMockMessage('Hi', 'ai')];

    await addMessagesAction({
      client,
      tableName: 'history',
      userId: 'user-123',
      sessionId: 'session-1',
      messages,
    });

    expect(ddbDocMock.calls()).toHaveLength(1);
  });

  it('should add multiple messages to existing session', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    ddbDocMock.onAnyCommand().resolvesOnce({
      Item: {
        userId: 'user-123',
        sessionId: 'session-1',
        messages: [createMockMessage('Previous')],
        title: 'Existing',
        messageCount: 1,
      },
    });
    ddbDocMock.onAnyCommand().resolvesOnce({});

    const messages = [createMockMessage('New 1'), createMockMessage('New 2')];

    await addMessagesAction({
      client,
      tableName: 'history',
      userId: 'user-123',
      sessionId: 'session-1',
      messages,
    });

    expect(ddbDocMock.calls()).toHaveLength(1);
  });

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

  it('should add messages to new session with provided title', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    ddbDocMock.onAnyCommand().resolvesOnce({});
    ddbDocMock.onAnyCommand().resolvesOnce({});

    const messages = [createMockMessage('Hello'), createMockMessage('Hi', 'ai')];

    await addMessagesAction({
      client,
      tableName: 'history',
      userId: 'user-123',
      sessionId: 'session-1',
      messages,
      title: 'Custom Title',
    });

    expect(ddbDocMock.calls()).toHaveLength(1);
  });

  it('should add messages to new session with TTL', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    ddbDocMock.onAnyCommand().resolvesOnce({});
    ddbDocMock.onAnyCommand().resolvesOnce({});

    const messages = [createMockMessage('Message 1'), createMockMessage('Message 2')];

    await addMessagesAction({
      client,
      tableName: 'history',
      userId: 'user-123',
      sessionId: 'session-1',
      messages,
      ttlDays: 7,
    });

    expect(ddbDocMock.calls()).toHaveLength(1);
  });

  it('should add messages to existing session with TTL', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    ddbDocMock.onAnyCommand().resolvesOnce({
      Item: {
        userId: 'user-123',
        sessionId: 'session-1',
        messages: [createMockMessage('Previous')],
        title: 'Existing',
        messageCount: 1,
      },
    });
    ddbDocMock.onAnyCommand().resolvesOnce({});

    const messages = [createMockMessage('New 1'), createMockMessage('New 2')];

    await addMessagesAction({
      client,
      tableName: 'history',
      userId: 'user-123',
      sessionId: 'session-1',
      messages,
      ttlDays: 30,
    });

    expect(ddbDocMock.calls()).toHaveLength(1);
  });
});
