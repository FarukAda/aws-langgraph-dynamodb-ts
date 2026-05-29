import { DynamoDBSaver } from '../../src/index';

describe('public entry point', () => {
  it('exports the DynamoDBSaver class', () => {
    expect(typeof DynamoDBSaver).toBe('function');
    expect(DynamoDBSaver.prototype.getTuple).toBeDefined();
  });
});
