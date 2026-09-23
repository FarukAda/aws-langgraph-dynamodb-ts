import {
  GET_MESSAGES_KEYS,
  HISTORY_KEYS,
  LIST_SESSIONS_KEYS,
} from '../../../../src/history/internal/option-keys';

describe('the chat-history option-key lists (compiler-verified against the types)', () => {
  it('lists exactly what the chat history reads from each options bag', () => {
    expect(HISTORY_KEYS).toEqual([
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
      'onCorruptMessage',
    ]);
    expect(GET_MESSAGES_KEYS).toEqual(['limit', 'before', 'signal']);
    expect(LIST_SESSIONS_KEYS).toEqual(['limit', 'cursor', 'maxIterations', 'maxItems', 'signal']);
  });
});
