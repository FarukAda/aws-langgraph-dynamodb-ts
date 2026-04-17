import * as indexExports from '../src/index';

describe('index exports', () => {
  it('exports DynamoDBSaver as a constructor', () => {
    expect(typeof indexExports.DynamoDBSaver).toBe('function');
  });

  it('exports DynamoDBStore as a constructor', () => {
    expect(typeof indexExports.DynamoDBStore).toBe('function');
  });

  it('exports DynamoDBChatMessageHistory as a constructor', () => {
    expect(typeof indexExports.DynamoDBChatMessageHistory).toBe('function');
  });

  it('exports DynamoDBFactory with the expected static methods', () => {
    expect(typeof indexExports.DynamoDBFactory).toBe('function');
    expect(typeof indexExports.DynamoDBFactory.createSaver).toBe('function');
    expect(typeof indexExports.DynamoDBFactory.createStore).toBe('function');
    expect(typeof indexExports.DynamoDBFactory.createChatMessageHistory).toBe('function');
    expect(typeof indexExports.DynamoDBFactory.createAll).toBe('function');
  });

  it('exports the logger control functions', () => {
    expect(typeof indexExports.setGlobalLogger).toBe('function');
    expect(typeof indexExports.getLogger).toBe('function');
    expect(typeof indexExports.resetLogger).toBe('function');

    // Round-trip: setGlobalLogger → getLogger → resetLogger returns to default.
    const custom = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    indexExports.setGlobalLogger(custom);
    expect(indexExports.getLogger()).toBe(custom);
    indexExports.resetLogger();
    expect(indexExports.getLogger()).not.toBe(custom);
  });
});
