import { DynamoDBChatMessageHistory } from '../../src';
import * as actions from '../../src/history/actions';

// Mock all the action functions
jest.mock('../../src/history/actions');

describe('DynamoDBChatMessageHistory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create instance with required options', () => {
      const history = new DynamoDBChatMessageHistory({
        tableName: 'chat-history',
      });

      expect(history).toBeInstanceOf(DynamoDBChatMessageHistory);
    });

    it('should create instance with TTL option', () => {
      const history = new DynamoDBChatMessageHistory({
        tableName: 'chat-history',
        ttlDays: 30,
      });

      expect(history).toBeInstanceOf(DynamoDBChatMessageHistory);
    });

    it('should create instance with client config', () => {
      const history = new DynamoDBChatMessageHistory({
        tableName: 'chat-history',
        clientConfig: { region: 'us-east-1' },
      });

      expect(history).toBeInstanceOf(DynamoDBChatMessageHistory);
    });
  });

  describe('getMessages', () => {
    it('should call getMessagesAction with correct params', async () => {
      const mockMessages = ['msg1', 'msg2'] as any;
      (actions.getMessagesAction as jest.Mock).mockResolvedValue(mockMessages);

      const history = new DynamoDBChatMessageHistory({
        tableName: 'chat-history',
      });

      const result = await history.getMessages('user-1', 'session-1');

      expect(actions.getMessagesAction).toHaveBeenCalledWith(
        expect.objectContaining({
          tableName: 'chat-history',
          userId: 'user-1',
          sessionId: 'session-1',
        }),
      );
      expect(result).toBe(mockMessages);
    });
  });

  describe('addMessage', () => {
    it('should call addMessageAction with correct params', async () => {
      (actions.addMessageAction as jest.Mock).mockResolvedValue(undefined);

      const history = new DynamoDBChatMessageHistory({
        tableName: 'chat-history',
      });

      const message = { content: 'Hello' } as any;

      await history.addMessage('user-1', 'session-1', message);

      expect(actions.addMessageAction).toHaveBeenCalledWith(
        expect.objectContaining({
          tableName: 'chat-history',
          userId: 'user-1',
          sessionId: 'session-1',
          message,
          ttlDays: undefined,
        }),
      );
    });

    it('should pass TTL from constructor', async () => {
      (actions.addMessageAction as jest.Mock).mockResolvedValue(undefined);

      const history = new DynamoDBChatMessageHistory({
        tableName: 'chat-history',
        ttlDays: 30,
      });

      const message = { content: 'Hello' } as any;

      await history.addMessage('user-1', 'session-1', message, 'Custom Title');

      expect(actions.addMessageAction).toHaveBeenCalledWith(
        expect.objectContaining({
          ttlDays: 30,
          title: 'Custom Title',
        }),
      );
    });
  });

  describe('addMessages', () => {
    it('should call addMessagesAction with correct params', async () => {
      (actions.addMessagesAction as jest.Mock).mockResolvedValue(undefined);

      const history = new DynamoDBChatMessageHistory({
        tableName: 'chat-history',
      });

      const messages = [{ content: 'Hello' }, { content: 'Hi' }] as any;

      await history.addMessages('user-1', 'session-1', messages);

      expect(actions.addMessagesAction).toHaveBeenCalledWith(
        expect.objectContaining({
          tableName: 'chat-history',
          userId: 'user-1',
          sessionId: 'session-1',
          messages,
        }),
      );
    });
  });

  describe('clear', () => {
    it('should call clearAction with correct params', async () => {
      (actions.clearAction as jest.Mock).mockResolvedValue(undefined);

      const history = new DynamoDBChatMessageHistory({
        tableName: 'chat-history',
      });

      await history.clear('user-1', 'session-1');

      expect(actions.clearAction).toHaveBeenCalledWith(
        expect.objectContaining({
          tableName: 'chat-history',
          userId: 'user-1',
          sessionId: 'session-1',
        }),
      );
    });
  });

  describe('listSessions', () => {
    it('should call listSessionsAction with correct params', async () => {
      const mockSessions = [{ sessionId: 'session-1' }] as any;
      (actions.listSessionsAction as jest.Mock).mockResolvedValue(mockSessions);

      const history = new DynamoDBChatMessageHistory({
        tableName: 'chat-history',
      });

      const result = await history.listSessions('user-1');

      expect(actions.listSessionsAction).toHaveBeenCalledWith(
        expect.objectContaining({
          tableName: 'chat-history',
          userId: 'user-1',
          limit: undefined,
        }),
      );
      expect(result).toBe(mockSessions);
    });

    it('should pass limit parameter', async () => {
      (actions.listSessionsAction as jest.Mock).mockResolvedValue([]);

      const history = new DynamoDBChatMessageHistory({
        tableName: 'chat-history',
      });

      await history.listSessions('user-1', 10);

      expect(actions.listSessionsAction).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 10,
        }),
      );
    });
  });
});
