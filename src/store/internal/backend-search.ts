import type {
  IndexConfig,
  Item,
  SearchItem,
  SearchOperation,
} from '@langchain/langgraph-checkpoint';

import { ValidationError } from '../../shared/errors/errors';
import { getItem } from '../actions/get';
import type { VectorBackend, VectorMatch } from '../vector-backend';
import { namespaceMatchesPrefix } from './keys';
import { toRelevanceScores } from './score-direction';
import { passesFilter } from './search-filter';
import type { StoreContext } from './setup';

/**
 * Warn when a backend's own ordering disagrees with its scores. A backend
 * returning a raw distance still hands back nearest-first, so the order looks
 * right while every score means the opposite of what {@link VectorMatch.score}
 * promises — ascending scores are that exact signature. Results are never
 * reordered on this basis: a correctly-scored backend's order is authoritative.
 */
function warnOnNonDescendingScores(
  context: StoreContext,
  matches: VectorMatch[],
  namespacePrefix: string[],
): void {
  const descending = matches.every(
    (match, position) => position === 0 || matches[position - 1].score >= match.score,
  );
  if (descending) return;
  context.logger.warn(
    'search: vectorBackend returned ascending scores; VectorMatch.score must be a relevance ' +
      '(higher is better), not a distance — results are forwarded in the order the backend gave',
    { namespacePrefix },
  );
}

/**
 * Read the canonical item a backend match points at, or `undefined` when the
 * match is unusable. `getItem` validates, so a backend returning a namespace
 * element containing the reserved separator would otherwise turn the whole
 * search into a ValidationError instead of dropping the one bad match.
 */
async function fetchMatch(context: StoreContext, match: VectorMatch): Promise<Item | null> {
  try {
    return await getItem(context, match.namespace, match.key);
  } catch (error) {
    context.logger.warn('search: skipped an unusable vectorBackend match', {
      namespace: match.namespace,
      key: match.key,
      reason: (error as Error).name,
    });
    return null;
  }
}

export async function searchViaBackend(
  context: StoreContext,
  backend: VectorBackend,
  index: IndexConfig,
  op: SearchOperation,
  offset: number,
  limit: number,
): Promise<SearchItem[]> {
  const queryVector = await index.embeddings.embedQuery(op.query as string);
  const need = offset + limit;
  if (need > context.maxSearchCandidates) {
    throw new ValidationError(
      `Requested page (offset ${offset} + limit ${limit} = ${need}) exceeds maxSearchCandidates ` +
        `(${context.maxSearchCandidates}); narrow the page or raise maxSearchCandidates`,
      'maxSearchCandidates',
    );
  }
  let topK = Math.min(need, context.maxSearchCandidates);
  let results: SearchItem[];
  for (;;) {
    const matches = toRelevanceScores(
      await backend.query(op.namespacePrefix, queryVector, topK),
      context.vectorScoreDirection,
    );
    warnOnNonDescendingScores(context, matches, op.namespacePrefix);
    results = [];
    for (const match of matches) {
      if (!namespaceMatchesPrefix(match.namespace, op.namespacePrefix)) continue;
      const item = await fetchMatch(context, match);
      if (item && passesFilter(item, op)) results.push({ ...item, score: match.score });
    }
    if (results.length >= need || matches.length < topK || topK >= context.maxSearchCandidates)
      break;
    topK = Math.min(topK * 2, context.maxSearchCandidates);
  }
  return results;
}
