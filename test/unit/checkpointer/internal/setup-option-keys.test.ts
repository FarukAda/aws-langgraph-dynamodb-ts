import { SAVER_KEYS } from '../../../../src/checkpointer/internal/setup';

describe('the checkpointer option-key list (compiler-verified against the type)', () => {
  it('lists exactly what the saver reads from its constructor options', () => {
    expect(SAVER_KEYS).toEqual([
      'tableName',
      'client',
      'clientConfig',
      'createClient',
      'ttl',
      'logger',
      'retry',
      'indexShards',
      'indexName',
      'readConcurrency',
      'compression',
      's3',
      'serde',
    ]);
  });
});
