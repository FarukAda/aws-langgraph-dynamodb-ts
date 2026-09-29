import {
  STORE_KEYS,
  STORE_LIST_NAMESPACES_KEYS,
  STORE_SEARCH_KEYS,
} from '../../../../src/store/internal/setup';

describe('the store option-key lists (compiler-verified against the types)', () => {
  it('lists exactly what the store reads from each options bag', () => {
    expect(STORE_KEYS).toEqual([
      'tableName',
      'client',
      'clientConfig',
      'createClient',
      'ttl',
      'logger',
      'retry',
      'readConcurrency',
      'compression',
      's3',
      'serde',
      'index',
      'vectorBackend',
      'maxSearchCandidates',
      'maxScanItems',
      'maxIterations',
      'vectorScoreDirection',
    ]);
    expect(STORE_SEARCH_KEYS).toEqual(['filter', 'limit', 'offset', 'query', 'signal']);
    expect(STORE_LIST_NAMESPACES_KEYS).toEqual(['prefix', 'suffix', 'maxDepth', 'limit', 'offset']);
  });
});
