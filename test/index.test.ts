import * as indexExports from '../src/index';

describe('index exports', () => {
  it('should export DynamoDBSaver', () => {
    expect(indexExports.DynamoDBSaver).toBeDefined();
    expect(typeof indexExports.DynamoDBSaver).toBe('function');
  });

  it('should export DynamoDBStore', () => {
    expect(indexExports.DynamoDBStore).toBeDefined();
    expect(typeof indexExports.DynamoDBStore).toBe('function');
  });
});
