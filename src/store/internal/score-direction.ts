import type { VectorMatch } from '../vector-backend';

/** Which direction a {@link VectorBackend} reports its score in. */
export type VectorScoreDirection = 'relevance' | 'distance';

/** Every direction {@link toRelevanceScores} recognises, for validating input. */
export const VECTOR_SCORE_DIRECTIONS: readonly VectorScoreDirection[] = ['relevance', 'distance'];

/**
 * Normalise a backend's matches to the relevance direction upstream
 * `SearchItem.score` documents — "higher scores indicate better matches",
 * typically a cosine similarity between -1 and 1.
 *
 * A distance is converted by **negation** rather than `1 / (1 + d)`: negation
 * is monotone over the whole real line, needs no non-negativity precondition,
 * and is exactly invertible, so the original distance is simply `-score`. A
 * reciprocal would silently imply a different `(0, 1]` scale and is undefined
 * at `d === -1`. Negative scores are already in range for this contract, so
 * nothing is lost by producing them.
 *
 * Results are re-sorted after conversion so a backend that returns its matches
 * in some other order still ranks correctly. Anything that is not `'distance'`
 * is returned untouched — its own order stays authoritative, exactly as before.
 *
 * The test is for `'distance'` rather than against `'relevance'` on purpose:
 * converting is the destructive branch, so only the exact value that asks for
 * it may reach it. Testing the other way round made every unrecognised
 * string — `'Distance'`, a typo, a value read from a config file — reverse the
 * ranking silently, with no error and no warning (the ascending-score warning
 * lives downstream of this conversion, so it could never fire). `setUpStore`
 * rejects such a value outright; this keeps the failure harmless for any
 * caller that reaches the function some other way.
 */
export function toRelevanceScores(
  matches: VectorMatch[],
  direction: VectorScoreDirection,
): VectorMatch[] {
  if (direction !== 'distance') return matches;
  return matches
    .map((match) => ({ ...match, score: -match.score }))
    .sort((left, right) => right.score - left.score);
}
