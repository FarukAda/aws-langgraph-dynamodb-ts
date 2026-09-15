import type {
  IndexConfig,
  Item,
  SearchItem,
  SearchOperation,
} from '@langchain/langgraph-checkpoint';

import { mapWithConcurrency } from '../../shared/concurrency';
import { DEFAULT_READ_CONCURRENCY } from '../../shared/constants';
import { ValidationError } from '../../shared/errors/errors';
import { getItem } from '../actions/get';
import type { VectorBackend, VectorMatch } from '../vector-backend';
import { namespaceMatchesPrefix } from './keys';
import { toRelevanceScores } from './score-direction';
import { passesFilter } from './search-filter';
import { assertVectorDims } from './semantic-search';
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
async function fetchMatch(
  context: StoreContext,
  match: VectorMatch,
  signal?: AbortSignal,
): Promise<Item | null> {
  try {
    return await getItem(context, match.namespace, match.key, signal);
  } catch (error) {
    context.logger.warn('search: skipped an unusable vectorBackend match', {
      namespace: match.namespace,
      key: match.key,
      reason: (error as Error).name,
    });
    return null;
  }
}

/** Stable, collision-free identity for a match, so one call reads each item once. */
function matchIdentity(match: VectorMatch): string {
  return JSON.stringify([match.namespace, match.key]);
}

/**
 * Read the canonical item behind every match this call has not read yet, into
 * `fetched`.
 *
 * Each round asks the backend for a larger `topK`, and the answer *contains*
 * the previous round's matches, so re-reading them cost one DynamoDB read — and
 * one S3 download for an offloaded item — per match per round. Remembering the
 * reads bounds a whole search at one read per distinct match. The same map also
 * covers a backend that returns one key twice in a single round.
 *
 * What a caller trades for it: an item changed between two rounds is answered
 * from the first read. A search is not a transaction and the rounds are
 * milliseconds apart, so the alternative — re-reading to catch a write that may
 * as well have landed a moment later — buys nothing.
 */
async function fetchUnseen(
  context: StoreContext,
  scoped: readonly VectorMatch[],
  fetched: Map<string, Item | null>,
  signal?: AbortSignal,
): Promise<void> {
  const unseen = new Map<string, VectorMatch>();
  for (const match of scoped) {
    const identity = matchIdentity(match);
    if (!fetched.has(identity)) unseen.set(identity, match);
  }
  const pending = [...unseen.values()];
  const items = await mapWithConcurrency(
    pending,
    context.readConcurrency ?? DEFAULT_READ_CONCURRENCY,
    (match) => fetchMatch(context, match, signal),
  );
  pending.forEach((match, index) => fetched.set(matchIdentity(match), items[index]));
}

/**
 * Rank a search through a configured vector backend.
 *
 * Accepts: `op.query` — non-empty; the caller checks that before choosing this
 * path. `offset`/`limit` — the page, whose end (`offset + limit`) must fit
 * within `maxSearchCandidates`, since that many matches have to be fetched to
 * fill it. `op.filter` — applied to the canonical item, not to whatever the
 * backend stored, so a filter is never answered from a stale vector.
 *
 * Returns: the page's items in the backend's order, each carrying the relevance
 * score for its vector. Fewer than `limit` items means the backend has no more
 * matches under the prefix, not that the page was cut short.
 *
 * Throws: ValidationError naming `index.dims` when the query embeds to a
 * different width than the index declares, and naming `maxSearchCandidates`
 * either for a page larger than the cap or when the filter leaves the page short
 * at the cap — the same answer the in-DynamoDB ranker gives, rather than a
 * silently short page. Whatever the embeddings model and the backend throw.
 *
 * Guarantees: DynamoDB stays canonical. A match whose item has since been
 * deleted, lies outside the prefix, or cannot be read is dropped and the search
 * asks the backend for more, so a stale or over-broad index costs results only
 * in latency. Items are fetched with the same bounded concurrency as the
 * in-DynamoDB path, and each distinct match is read once for the whole call
 * however many rounds it takes (see {@link fetchUnseen}).
 */
export async function searchViaBackend(
  context: StoreContext,
  backend: VectorBackend,
  index: IndexConfig,
  op: SearchOperation,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<SearchItem[]> {
  const queryVector = await index.embeddings.embedQuery(op.query as string);
  assertVectorDims(index, queryVector, 'query');
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
  const fetched = new Map<string, Item | null>();
  for (;;) {
    const matches = toRelevanceScores(
      await backend.query(op.namespacePrefix, queryVector, topK),
      context.vectorScoreDirection,
    );
    warnOnNonDescendingScores(context, matches, op.namespacePrefix);
    const scoped = matches.filter((match) =>
      namespaceMatchesPrefix(match.namespace, op.namespacePrefix),
    );
    await fetchUnseen(context, scoped, fetched, signal);
    results = [];
    for (const match of scoped) {
      const item = fetched.get(matchIdentity(match));
      if (item && passesFilter(item, op)) results.push({ ...item, score: match.score });
    }
    if (results.length >= need || matches.length < topK) break;
    if (topK >= context.maxSearchCandidates) {
      /** The backend still holds matches, but the filter left the page short at the cap: the same answer the in-DB ranker gives, not a silently short page. */
      throw new ValidationError(
        `Semantic search collected ${results.length} of ${need} matches within maxSearchCandidates ` +
          `(${context.maxSearchCandidates}); narrow the filter or raise maxSearchCandidates`,
        'maxSearchCandidates',
      );
    }
    topK = Math.min(topK * 2, context.maxSearchCandidates);
  }
  return results;
}
