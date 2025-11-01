import { DynamoDBFactory, DynamoDBSaver, DynamoDBStore, DynamoDBChatMessageHistory } from '../src';

describe('DynamoDBFactory', () => {
  describe('createSaver', () => {
    it('should create DynamoDBSaver with default table names', () => {
      const saver = DynamoDBFactory.createSaver();
      expect(saver).toBeInstanceOf(DynamoDBSaver);
    });

    it('should create DynamoDBSaver with custom table names', () => {
      const saver = DynamoDBFactory.createSaver({
        checkpointsTableName: 'custom-checkpoints',
        writesTableName: 'custom-writes',
      });
      expect(saver).toBeInstanceOf(DynamoDBSaver);
    });

    it('should create DynamoDBSaver with TTL', () => {
      const saver = DynamoDBFactory.createSaver({
        ttlDays: 30,
      });
      expect(saver).toBeInstanceOf(DynamoDBSaver);
    });

    it('should create DynamoDBSaver with client config', () => {
      const saver = DynamoDBFactory.createSaver({
        clientConfig: { region: 'us-east-1' },
      });
      expect(saver).toBeInstanceOf(DynamoDBSaver);
    });
  });

  describe('createStore', () => {
    it('should create DynamoDBStore with default table name', () => {
      const store = DynamoDBFactory.createStore();
      expect(store).toBeInstanceOf(DynamoDBStore);
    });

    it('should create DynamoDBStore with custom table name', () => {
      const store = DynamoDBFactory.createStore({
        memoryTableName: 'custom-memory',
      });
      expect(store).toBeInstanceOf(DynamoDBStore);
    });

    it('should create DynamoDBStore with TTL', () => {
      const store = DynamoDBFactory.createStore({
        ttlDays: 90,
      });
      expect(store).toBeInstanceOf(DynamoDBStore);
    });

    it('should create DynamoDBStore with client config', () => {
      const store = DynamoDBFactory.createStore({
        clientConfig: { region: 'us-west-2' },
      });
      expect(store).toBeInstanceOf(DynamoDBStore);
    });
  });

  describe('createChatMessageHistory', () => {
    it('should create DynamoDBChatMessageHistory with default table name', () => {
      const history = DynamoDBFactory.createChatMessageHistory();
      expect(history).toBeInstanceOf(DynamoDBChatMessageHistory);
    });

    it('should create DynamoDBChatMessageHistory with custom table name', () => {
      const history = DynamoDBFactory.createChatMessageHistory({
        tableName: 'custom-chat-history',
      });
      expect(history).toBeInstanceOf(DynamoDBChatMessageHistory);
    });

    it('should create DynamoDBChatMessageHistory with TTL', () => {
      const history = DynamoDBFactory.createChatMessageHistory({
        ttlDays: 365,
      });
      expect(history).toBeInstanceOf(DynamoDBChatMessageHistory);
    });

    it('should create DynamoDBChatMessageHistory with client config', () => {
      const history = DynamoDBFactory.createChatMessageHistory({
        clientConfig: { region: 'eu-west-1' },
      });
      expect(history).toBeInstanceOf(DynamoDBChatMessageHistory);
    });
  });

  describe('createAll', () => {
    it('should create all instances with default configuration', () => {
      const { checkpointer, store, chatHistory } = DynamoDBFactory.createAll();

      expect(checkpointer).toBeInstanceOf(DynamoDBSaver);
      expect(store).toBeInstanceOf(DynamoDBStore);
      expect(chatHistory).toBeInstanceOf(DynamoDBChatMessageHistory);
    });

    it('should create all instances with custom table prefix', () => {
      const { checkpointer, store, chatHistory } = DynamoDBFactory.createAll({
        tablePrefix: 'my-app',
      });

      expect(checkpointer).toBeInstanceOf(DynamoDBSaver);
      expect(store).toBeInstanceOf(DynamoDBStore);
      expect(chatHistory).toBeInstanceOf(DynamoDBChatMessageHistory);
    });

    it('should create all instances with shared TTL', () => {
      const { checkpointer, store, chatHistory } = DynamoDBFactory.createAll({
        ttlDays: 30,
      });

      expect(checkpointer).toBeInstanceOf(DynamoDBSaver);
      expect(store).toBeInstanceOf(DynamoDBStore);
      expect(chatHistory).toBeInstanceOf(DynamoDBChatMessageHistory);
    });

    it('should create all instances with shared client config', () => {
      const { checkpointer, store, chatHistory } = DynamoDBFactory.createAll({
        clientConfig: { region: 'us-east-1' },
      });

      expect(checkpointer).toBeInstanceOf(DynamoDBSaver);
      expect(store).toBeInstanceOf(DynamoDBStore);
      expect(chatHistory).toBeInstanceOf(DynamoDBChatMessageHistory);
    });

    it('should create all instances with complete configuration', () => {
      const { checkpointer, store, chatHistory } = DynamoDBFactory.createAll({
        tablePrefix: 'my-app',
        ttlDays: 60,
        clientConfig: { region: 'ap-southeast-1' },
      });

      expect(checkpointer).toBeInstanceOf(DynamoDBSaver);
      expect(store).toBeInstanceOf(DynamoDBStore);
      expect(chatHistory).toBeInstanceOf(DynamoDBChatMessageHistory);
    });

    it('should use correct table names with custom prefix', () => {
      const result = DynamoDBFactory.createAll({
        tablePrefix: 'test-prefix',
      });

      // We can't directly test internal table names without exposing them,
      // but we can verify the instances are created correctly
      expect(result.checkpointer).toBeInstanceOf(DynamoDBSaver);
      expect(result.store).toBeInstanceOf(DynamoDBStore);
      expect(result.chatHistory).toBeInstanceOf(DynamoDBChatMessageHistory);
    });
  });

  describe('integration', () => {
    it('should create instances that can be used together', () => {
      const { checkpointer, store, chatHistory } = DynamoDBFactory.createAll({
        tablePrefix: 'integration-test',
        ttlDays: 7,
        clientConfig: { region: 'us-east-1' },
      });

      // Verify all instances are created and ready to use
      expect(checkpointer).toBeDefined();
      expect(store).toBeDefined();
      expect(chatHistory).toBeDefined();

      // Verify they are the correct types
      expect(checkpointer).toBeInstanceOf(DynamoDBSaver);
      expect(store).toBeInstanceOf(DynamoDBStore);
      expect(chatHistory).toBeInstanceOf(DynamoDBChatMessageHistory);
    });
  });
});
