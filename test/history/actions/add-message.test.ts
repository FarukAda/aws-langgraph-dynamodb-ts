import { addMessageAction } from '../../../src/history/actions';
import { createMockDynamoDBClient } from '../../shared/mocks/dynamodb-mock';
import { createMockMessage } from '../../shared/fixtures/test-data';

describe('addMessageAction', () => {
  it('should add message to new session with auto-generated title', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    // Mock get call returns no item (new session)
    ddbDocMock.onAnyCommand().resolvesOnce({});
    // Mock update call
    ddbDocMock.onAnyCommand().resolvesOnce({});

    const message = createMockMessage('Hello, world!');

    await addMessageAction({
      client,
      tableName: 'history',
      userId: 'user-123',
      sessionId: 'session-1',
      message,
    });

    expect(ddbDocMock.calls()).toHaveLength(1);
  });

  it('should add message to new session with provided title', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    ddbDocMock.onAnyCommand().resolvesOnce({});
    ddbDocMock.onAnyCommand().resolvesOnce({});

    const message = createMockMessage('Hello, world!');

    await addMessageAction({
      client,
      tableName: 'history',
      userId: 'user-123',
      sessionId: 'session-1',
      message,
      title: 'Custom Title',
    });

    expect(ddbDocMock.calls()).toHaveLength(1);
  });

  it('should add message to existing session', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    // Mock get call returns existing item
    ddbDocMock.onAnyCommand().resolvesOnce({
      Item: {
        userId: 'user-123',
        sessionId: 'session-1',
        messages: [createMockMessage('Previous message')],
        title: 'Existing Session',
        messageCount: 1,
      },
    });
    ddbDocMock.onAnyCommand().resolvesOnce({});

    const message = createMockMessage('New message');

    await addMessageAction({
      client,
      tableName: 'history',
      userId: 'user-123',
      sessionId: 'session-1',
      message,
    });

    expect(ddbDocMock.calls()).toHaveLength(1);
  });

  it('should throw error for invalid user ID', async () => {
    const { client } = createMockDynamoDBClient();

    await expect(
      addMessageAction({
        client,
        tableName: 'history',
        userId: '',
        sessionId: 'session-1',
        message: createMockMessage('Test'),
      }),
    ).rejects.toThrow('User ID cannot be empty');
  });

  it('should throw error for invalid session ID', async () => {
    const { client } = createMockDynamoDBClient();

    await expect(
      addMessageAction({
        client,
        tableName: 'history',
        userId: 'user-123',
        sessionId: '',
        message: createMockMessage('Test'),
      }),
    ).rejects.toThrow('Session ID cannot be empty');
  });

  it('should throw error for invalid message', async () => {
    const { client } = createMockDynamoDBClient();

    await expect(
      addMessageAction({
        client,
        tableName: 'history',
        userId: 'user-123',
        sessionId: 'session-1',
        message: null as any,
      }),
    ).rejects.toThrow('Message cannot be null or undefined');
  });

  it('should throw error for invalid title', async () => {
    const { client } = createMockDynamoDBClient();

    const longTitle = 'a'.repeat(201);

    await expect(
      addMessageAction({
        client,
        tableName: 'history',
        userId: 'user-123',
        sessionId: 'session-1',
        message: createMockMessage('Test'),
        title: longTitle,
      }),
    ).rejects.toThrow('Title exceeds maximum length');
  });

  it('should add message to new session with TTL', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    ddbDocMock.onAnyCommand().resolvesOnce({});
    ddbDocMock.onAnyCommand().resolvesOnce({});

    const message = createMockMessage('Hello, world!');

    await addMessageAction({
      client,
      tableName: 'history',
      userId: 'user-123',
      sessionId: 'session-1',
      message,
      ttlDays: 7,
    });

    expect(ddbDocMock.calls()).toHaveLength(1);
  });

  it('should add message to existing session with TTL', async () => {
    const { ddbDocMock, client } = createMockDynamoDBClient();

    ddbDocMock.onAnyCommand().resolvesOnce({
      Item: {
        userId: 'user-123',
        sessionId: 'session-1',
        messages: [createMockMessage('Previous message')],
        title: 'Existing Session',
        messageCount: 1,
      },
    });
    ddbDocMock.onAnyCommand().resolvesOnce({});

    const message = createMockMessage('New message');

    await addMessageAction({
      client,
      tableName: 'history',
      userId: 'user-123',
      sessionId: 'session-1',
      message,
      ttlDays: 30,
    });

    expect(ddbDocMock.calls()).toHaveLength(1);
  });
});
