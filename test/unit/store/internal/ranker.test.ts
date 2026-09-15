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
  return { item, embeddings: embedding ? [embedding] : undefined };
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

  it('reports how many candidates carried a dimension-mismatched embedding', () => {
    const onMismatch = jest.fn();
    rankInMemory(
      [candidate('stale', [1, 0, 0]), candidate('ok', [1, 0]), candidate('none')],
      [1, 0],
      10,
      onMismatch,
    );
    expect(onMismatch).toHaveBeenCalledTimes(1);
    expect(onMismatch).toHaveBeenCalledWith(1);
  });

  it('does not report when every stored embedding matches the query dimension', () => {
    const onMismatch = jest.fn();
    rankInMemory([candidate('ok', [1, 0]), candidate('none')], [1, 0], 10, onMismatch);
    expect(onMismatch).not.toHaveBeenCalled();
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

describe('rankInMemory scores an item by its best passage (STORE-10)', () => {
  function multi(key: string, embeddings: number[][]): RankCandidate {
    return {
      item: {
        namespace: ['n'],
        key,
        value: {},
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      embeddings,
    };
  }

  /**
   * The reference store embeds each extracted path separately and scores an
   * item by its best-matching one. Joining the paths and embedding once
   * averages a long document into a single point, so a document whose one
   * relevant section matches perfectly ranked below a document that matches
   * everywhere but weakly. This is that case.
   */
  it('ranks one perfectly-matching section above a uniformly weak match', () => {
    const query = [1, 0];
    const withSection = multi('long-doc', [
      [1, 0],
      [0, 1],
    ]);
    const uniformlyWeak = multi('short-doc', [[0.7071, 0.7071]]);
    const ranked = rankInMemory([uniformlyWeak, withSection], query, 10);
    expect(ranked.map((item) => item.key)).toEqual(['long-doc', 'short-doc']);
    expect(ranked[0].score).toBeCloseTo(1, 5);
  });

  it('ignores a vector of the wrong length but still scores a comparable one', () => {
    const ranked = rankInMemory(
      [
        multi('mixed', [
          [1, 0, 0],
          [1, 0],
        ]),
      ],
      [1, 0],
      10,
    );
    expect(ranked[0].score).toBeCloseTo(1, 5);
  });

  it('reports a dimension mismatch only when no vector of the item is comparable', () => {
    const onMismatch = jest.fn();
    rankInMemory(
      [
        multi('mixed', [
          [1, 0, 0],
          [1, 0],
        ]),
      ],
      [1, 0],
      10,
      onMismatch,
    );
    expect(onMismatch).not.toHaveBeenCalled();
    rankInMemory([multi('stale', [[1, 0, 0]])], [1, 0], 10, onMismatch);
    expect(onMismatch).toHaveBeenCalledWith(1);
  });

  it('scores a row written with a single joined vector exactly as before', () => {
    const ranked = rankInMemory([candidate('old', [1, 0])], [1, 0], 10);
    expect(ranked[0].score).toBeCloseTo(1, 5);
  });
});
