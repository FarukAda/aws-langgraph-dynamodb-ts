import { DynamoDBSaver, DynamoDBStore } from '../../src/index';

describe('public entry point', () => {
  it('exports the DynamoDBSaver class', () => {
    expect(typeof DynamoDBSaver).toBe('function');
    expect(DynamoDBSaver.prototype.getTuple).toBeDefined();
  });

  it('exports the DynamoDBStore class', () => {
    expect(typeof DynamoDBStore).toBe('function');
    expect(DynamoDBStore.prototype.batch).toBeDefined();
  });
});
