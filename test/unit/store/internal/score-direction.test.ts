import {
  toRelevanceScores,
  type VectorScoreDirection,
} from '../../../../src/store/internal/score-direction';
import type { VectorMatch } from '../../../../src/store/vector-backend';

const match = (key: string, score: number): VectorMatch => ({ namespace: ['n'], key, score });

describe('toRelevanceScores', () => {
  it('passes relevance-direction matches through untouched, by identity', () => {
    const matches = [match('a', 0.9), match('b', 0.1)];
    expect(toRelevanceScores(matches, 'relevance')).toBe(matches);
  });

  it('negates a distance so higher still means better', () => {
    // A distance backend returns nearest-first: 0.1 is the best match.
    const converted = toRelevanceScores([match('a', 0.1), match('b', 0.9)], 'distance');
    expect(converted.map((m) => [m.key, m.score])).toEqual([
      ['a', -0.1],
      ['b', -0.9],
    ]);
  });

  it('re-sorts descending so an unsorted distance backend still ranks correctly', () => {
    const converted = toRelevanceScores(
      [match('far', 0.9), match('near', 0.1), match('mid', 0.5)],
      'distance',
    );
    expect(converted.map((m) => m.key)).toEqual(['near', 'mid', 'far']);
  });

  it('does not mutate the caller array', () => {
    const matches = [match('a', 0.1)];
    toRelevanceScores(matches, 'distance');
    expect(matches[0].score).toBe(0.1);
  });

  it('handles a zero distance and a negative distance without special-casing', () => {
    const converted = toRelevanceScores([match('a', 0), match('b', -2)], 'distance');
    expect(converted.map((m) => [m.key, m.score])).toEqual([
      ['b', 2],
      ['a', -0],
    ]);
  });

  it('accepts the declared direction type', () => {
    const direction: VectorScoreDirection = 'distance';
    expect(toRelevanceScores([], direction)).toEqual([]);
  });

  it('leaves an unrecognised direction alone instead of silently inverting the ranking', () => {
    // 'relevance' used to be the only value treated as a no-op, so 'Distance',
    // 'DISTANCE', a typo, or any string from a config file fell through to
    // negate-and-re-sort and reversed the ranking with no error and no warn.
    const matches = [match('a', 0.9), match('b', 0.1)];
    expect(toRelevanceScores(matches, 'DISTANCE' as never)).toBe(matches);
    expect(toRelevanceScores(matches, 'relevence' as never)).toBe(matches);
    expect(toRelevanceScores(matches, '' as never)).toBe(matches);
  });
});
