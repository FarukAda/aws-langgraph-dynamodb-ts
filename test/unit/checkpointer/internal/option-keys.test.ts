import {
  DELTA_CHANNEL_HISTORY_KEYS,
  SAVER_KEYS,
  SAVER_LIST_KEYS,
} from '../../../../src/checkpointer/internal/option-keys';

describe('the checkpointer option-key lists (compiler-verified against the types)', () => {
  it('lists exactly what the checkpointer reads from each options bag', () => {
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
    expect(SAVER_LIST_KEYS).toEqual(['limit', 'before', 'filter']);
    expect(DELTA_CHANNEL_HISTORY_KEYS).toEqual(['config', 'channels']);
  });
});
