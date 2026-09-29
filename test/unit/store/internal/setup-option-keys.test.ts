import { STORE_KEYS } from '../../../../src/store/internal/setup';

describe('the store option-key list (compiler-verified against the type)', () => {
  it('lists exactly what the store reads from its constructor options', () => {
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
  });
});
