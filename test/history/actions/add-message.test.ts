import { addMessageAction } from '../../../src/history/actions';
import { createMockMessage } from '../../shared/fixtures/test-data';
import { expectDynamoDBCalled, expectValidationError } from '../../shared/helpers/assertions';
import { setupHistoryTest, type HistoryTestSetup } from '../../shared/helpers/test-setup';

describe('addMessageAction', () => {
  let setup: HistoryTestSetup;

  beforeEach(() => {
    setup = setupHistoryTest();
  });

  afterEach(() => {
    setup.cleanup();
  });

  it('should add message to new session with auto-generated title', async () => {
    // Mock atomic counter update (returns new messageCount)
    setup.ddbDocMock.onAnyCommand().resolvesOnce({
      Attributes: { messageCount: 1 },
    });
    // Mock put for message item
    setup.ddbDocMock.onAnyCommand().resolvesOnce({});

    const message = createMockMessage('Hello, world!');

    await addMessageAction({
      client: setup.client,
      tableName: 'history',
      userId: 'user-123',
      sessionId: 'session-1',
      message,
    });

    // 1 update (atomic counter) + 1 put (message item) = 2 calls
    expectDynamoDBCalled(setup.ddbDocMock, 2);
  });

  it('should add message to new session with provided title', async () => {
    setup.ddbDocMock.onAnyCommand().resolvesOnce({
      Attributes: { messageCount: 1 },
    });
    setup.ddbDocMock.onAnyCommand().resolvesOnce({});

    const message = createMockMessage('Hello, world!');

    await addMessageAction({
      client: setup.client,
      tableName: 'history',
      userId: 'user-123',
      sessionId: 'session-1',
      message,
      title: 'Custom Title',
    });

    expectDynamoDBCalled(setup.ddbDocMock, 2);
  });

  it('should add message to existing session with correct index', async () => {
    // Atomic counter returns new count of 4 (was 3, incremented by 1)
    setup.ddbDocMock.onAnyCommand().resolvesOnce({
      Attributes: { messageCount: 4 },
    });
    setup.ddbDocMock.onAnyCommand().resolvesOnce({});

    const message = createMockMessage('New message');

    await addMessageAction({
      client: setup.client,
      tableName: 'history',
      userId: 'user-123',
      sessionId: 'session-1',
      message,
    });

    expectDynamoDBCalled(setup.ddbDocMock, 2);
  });

  it('should throw error for invalid user ID', async () => {
    await expectValidationError(
      addMessageAction({
        client: setup.client,
        tableName: 'history',
        userId: '',
        sessionId: 'session-1',
        message: createMockMessage('Test'),
      }),
      'User ID cannot be empty',
    );
  });

  it('should throw error for invalid session ID', async () => {
    await expect(
      addMessageAction({
        client: setup.client,
        tableName: 'history',
        userId: 'user-123',
        sessionId: '',
        message: createMockMessage('Test'),
      }),
    ).rejects.toThrow('Session ID cannot be empty');
  });

  it('should throw error for invalid message', async () => {
    await expect(
      addMessageAction({
        client: setup.client,
        tableName: 'history',
        userId: 'user-123',
        sessionId: 'session-1',
        message: null as any,
      }),
    ).rejects.toThrow('Message cannot be null or undefined');
  });

  it('should throw error for invalid title', async () => {
    const longTitle = 'a'.repeat(201);

    await expect(
      addMessageAction({
        client: setup.client,
        tableName: 'history',
        userId: 'user-123',
        sessionId: 'session-1',
        message: createMockMessage('Test'),
        title: longTitle,
      }),
    ).rejects.toThrow('Title exceeds maximum length');
  });

  it('should add message to new session with TTL', async () => {
    setup.ddbDocMock.onAnyCommand().resolvesOnce({
      Attributes: { messageCount: 1 },
    });
    setup.ddbDocMock.onAnyCommand().resolvesOnce({});

    const message = createMockMessage('Hello, world!');

    await addMessageAction({
      client: setup.client,
      tableName: 'history',
      userId: 'user-123',
      sessionId: 'session-1',
      message,
      ttlDays: 7,
    });

    expectDynamoDBCalled(setup.ddbDocMock, 2);
  });

  it('should add message to existing session with TTL', async () => {
    setup.ddbDocMock.onAnyCommand().resolvesOnce({
      Attributes: { messageCount: 2 },
    });
    setup.ddbDocMock.onAnyCommand().resolvesOnce({});

    const message = createMockMessage('New message');

    await addMessageAction({
      client: setup.client,
      tableName: 'history',
      userId: 'user-123',
      sessionId: 'session-1',
      message,
      ttlDays: 30,
    });

    expectDynamoDBCalled(setup.ddbDocMock, 2);
  });
});
