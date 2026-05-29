import {
  DynamoDBChatMessageHistory,
  DynamoDBFactory,
  DynamoDBSaver,
  DynamoDBSessionChatMessageHistory,
  DynamoDBStore,
} from '../../src/index';

describe('public entry point', () => {
  it('exports the DynamoDBSaver class', () => {
    expect(typeof DynamoDBSaver).toBe('function');
    expect(DynamoDBSaver.prototype.getTuple).toBeDefined();
  });

  it('exports the DynamoDBStore class', () => {
    expect(typeof DynamoDBStore).toBe('function');
    expect(DynamoDBStore.prototype.batch).toBeDefined();
  });

  it('exports the chat message history classes', () => {
    expect(typeof DynamoDBChatMessageHistory).toBe('function');
    expect(DynamoDBChatMessageHistory.prototype.forSession).toBeDefined();
    expect(typeof DynamoDBSessionChatMessageHistory).toBe('function');
    expect(DynamoDBSessionChatMessageHistory.prototype.getMessages).toBeDefined();
  });

  it('exports the DynamoDBFactory', () => {
    expect(typeof DynamoDBFactory).toBe('function');
    expect(DynamoDBFactory.prototype.createAll).toBeDefined();
  });
});
