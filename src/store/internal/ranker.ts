import type { Item, SearchItem } from '@langchain/langgraph-checkpoint';

import { ValidationError } from '../../shared/errors/errors';
import { cosineSimilarity } from './semantic-search';

/** Sort weight for an item without an embedding; below the −1 cosine minimum. */
const UNSCORED_RANK = -2;

/** A decoded item plus its stored embedding, awaiting ranking. */
export interface RankCandidate {
  item: Item;
  embedding?: number[];
}

/**
 * Rank candidates by cosine similarity to `queryVector`, descending. Throws a
 * {@link ValidationError} when the candidate count exceeds `maxCandidates`
 * (steer large corpora to an external VectorBackend).
 */
export function rankInMemory(
  candidates: RankCandidate[],
  queryVector: number[],
  maxCandidates: number,
): SearchItem[] {
  if (candidates.length > maxCandidates) {
    throw new ValidationError(
      `Semantic search candidate set (${candidates.length}) exceeds maxSearchCandidates ` +
        `(${maxCandidates}); use a dedicated VectorBackend for large corpora`,
      'maxSearchCandidates',
    );
  }
  return candidates
    .map(({ item, embedding }) => ({
      ...item,
      score:
        embedding && embedding.length === queryVector.length
          ? cosineSimilarity(queryVector, embedding)
          : undefined,
    }))
    .sort((a, b) => rankValue(b) - rankValue(a));
}

/** Sort weight: real cosine score, or a value below the cosine minimum for unscored items. */
function rankValue(item: SearchItem): number {
  return item.score ?? UNSCORED_RANK;
}
