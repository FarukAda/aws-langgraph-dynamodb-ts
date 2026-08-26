import type { Item } from '@langchain/langgraph-checkpoint';

import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { type RankCandidate, rankInMemory } from '../../../../src/store/internal/ranker';

function candidate(key: string, embedding?: number[]): RankCandidate {
  const item: Item = {
    namespace: ['n'],
    key,
    value: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  return { item, embedding };
}

describe('rankInMemory', () => {
  it('ranks candidates by cosine similarity, descending', () => {
    const ranked = rankInMemory([candidate('a', [1, 0]), candidate('b', [0, 1])], [0, 1], 10);
    expect(ranked.map((r) => r.key)).toEqual(['b', 'a']);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score!);
  });

  it('ranks embedding-less candidates last with an undefined score', () => {
    const ranked = rankInMemory([candidate('a'), candidate('b', [-1, 0])], [1, 0], 10);
    expect(ranked.map((r) => r.key)).toEqual(['b', 'a']);
    expect(ranked[0].score).toBeCloseTo(-1);
    expect(ranked[1].score).toBeUndefined();
  });

  it('ranks a dimension-mismatched embedding as unscored rather than silently scoring it 0', () => {
    const ranked = rankInMemory([candidate('stale', [1, 0, 0]), candidate('nomatch')], [1, 0], 10);
    expect(ranked.map((r) => r.key).sort()).toEqual(['nomatch', 'stale']);
    expect(ranked.every((r) => r.score === undefined)).toBe(true);
  });

  it('throws a ValidationError when the candidate set exceeds the cap', () => {
    try {
      rankInMemory([candidate('a'), candidate('b')], [1, 0], 1);
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { code: ErrorCode }).code).toBe(ErrorCode.VALIDATION);
    }
  });
});
