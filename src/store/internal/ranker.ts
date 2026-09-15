import type { Item, SearchItem } from '@langchain/langgraph-checkpoint';

import { ValidationError } from '../../shared/errors/errors';
import { cosineSimilarity } from './semantic-search';

/** Sort weight for an item without an embedding; below the −1 cosine minimum. */
const UNSCORED_RANK = -2;

/** A decoded item plus its stored vectors, awaiting ranking. */
export interface RankCandidate {
  item: Item;
  /**
   * One vector per extracted path. A row written before the store embedded
   * per path carries a single vector and arrives here as a one-element list,
   * which scores identically to how it always did.
   */
  embeddings?: number[][];
}

/**
 * The best cosine similarity across an item's vectors, or undefined when none
 * can be compared. Scoring by the *best* passage rather than by an average is
 * what the reference store does, and it is why a long document with one
 * strongly-matching section is found.
 */
function bestScore(vectors: number[][], queryVector: number[]): number | undefined {
  let best: number | undefined;
  for (const vector of vectors) {
    if (vector.length !== queryVector.length) continue;
    const score = cosineSimilarity(queryVector, vector);
    if (best === undefined || score > best) best = score;
  }
  return best;
}

/** True when the candidate has vectors but none of a comparable length. */
function isDimensionMismatch(candidate: RankCandidate, queryVector: number[]): boolean {
  const vectors = candidate.embeddings;
  return (
    vectors !== undefined &&
    vectors.length > 0 &&
    vectors.every((vector) => vector.length !== queryVector.length)
  );
}

/**
 * Rank candidates by cosine similarity to `queryVector`, descending. Throws a
 * {@link ValidationError} when the candidate count exceeds `maxCandidates`
 * (steer large corpora to an external VectorBackend).
 *
 * An item is scored by its best-matching vector, as the reference store scores
 * its per-path embeddings. A stored vector whose length differs from the query
 * vector's cannot be scored — it was written by a different embeddings model —
 * and an item with no comparable vector at all is ranked last with an
 * undefined score. `onDimensionMismatch` is invoked once with how many
 * candidates that affected, so the caller can say so instead of silently
 * returning a ranking that quietly omits them.
 *
 * Accepts: `candidates` — in any order; empty ranks to empty. A candidate with
 * no `embeddings` was never indexed (indexing off at write time, or no
 * indexable text) and one with an empty list is the same thing. `queryVector` —
 * the embedded query; one of a different length than everything stored means
 * the query and the corpus were embedded by different models, and nothing
 * scores.
 *
 * Returns: every candidate, scored and sorted best-first. Nothing is dropped:
 * an unscorable item still belongs to the namespace the caller searched, and
 * dropping it would turn a model mismatch into a silently empty result.
 *
 * Throws: ValidationError naming `maxSearchCandidates` when more candidates
 * arrive than may be ranked in memory — a bound on this process's memory, not
 * on the corpus, which is what a `vectorBackend` is for.
 *
 * Guarantees: ranking reads the vectors only; no item is decoded or fetched
 * again, and `onDimensionMismatch` fires at most once per call.
 */
export function rankInMemory(
  candidates: RankCandidate[],
  queryVector: number[],
  maxCandidates: number,
  onDimensionMismatch?: (count: number) => void,
): SearchItem[] {
  if (candidates.length > maxCandidates) {
    throw new ValidationError(
      `Semantic search candidate set (${candidates.length}) exceeds maxSearchCandidates ` +
        `(${maxCandidates}); use a dedicated VectorBackend for large corpora`,
      'maxSearchCandidates',
    );
  }
  const mismatched = candidates.filter((candidate) =>
    isDimensionMismatch(candidate, queryVector),
  ).length;
  if (mismatched > 0) onDimensionMismatch?.(mismatched);
  return candidates
    .map(({ item, embeddings }) => ({
      ...item,
      score: embeddings ? bestScore(embeddings, queryVector) : undefined,
    }))
    .sort((a, b) => rankValue(b) - rankValue(a));
}

/** Sort weight: real cosine score, or a value below the cosine minimum for unscored items. */
function rankValue(item: SearchItem): number {
  return item.score ?? UNSCORED_RANK;
}
