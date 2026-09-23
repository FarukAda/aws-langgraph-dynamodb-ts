import type { SearchItem } from '@langchain/langgraph-checkpoint';

import { truncateLabelsForLog } from '../../shared/logging/truncate';
import { searchViaBackend } from '../internal/backend-search';
import { collectCandidates } from '../internal/candidates';
import type { ParsedSearch } from '../internal/parse';
import { rankInMemory } from '../internal/ranker';
import { assertVectorDims } from '../internal/semantic-search';
import type { StoreContext } from '../internal/setup';

/**
 * Search items under a namespace prefix: metadata filtering plus optional
 * semantic ranking.
 *
 * Accepts: `search` — already parsed, so `namespacePrefix`, `offset` and
 * `limit` are resolved; `search.query` absent or empty
 * (which is absent: there is no query to embed) ranks nothing and returns the
 * page as read, which is what the reference store does
 * (`@langchain/langgraph-checkpoint@1.1.5` `dist/store/memory.js:70-80`, where a
 * falsy query takes the unscored path). A query without a configured `index`
 * does the same, since there is nothing to embed it with.
 *
 * Returns: at most `limit` items from `offset`. With a query and an index every
 * item carries a `score`; without one none does. Scores rank best-first; an item
 * that cannot be scored ranks last rather than being dropped.
 *
 * Throws: `VALIDATION` naming `maxSearchCandidates` or `index.dims`; whatever
 * the reads, decodes and the embeddings model throw.
 *
 * Guarantees: a page of zero costs no request at all, and otherwise only the
 * page's own items are decoded on the unranked path — the
 * read stops as soon as it is full. A semantic search must read every candidate
 * to rank it, which is why it is capped and why a large corpus belongs in a
 * `vectorBackend`.
 */
export async function searchItems(
  context: StoreContext,
  search: ParsedSearch,
  signal?: AbortSignal,
): Promise<SearchItem[]> {
  const { offset, limit } = search;
  /**
   * A zero page is answered here, ahead of all three paths below, because each
   * of them pays for it: `collectCandidates` pulls the first row out of the
   * paginator before it tests its `offset + limit` bound, so even a page that
   * needs nothing costs one Query or Scan, and the two ranked paths embed the
   * query as well. Slicing the result to nothing afterwards hid the cost
   * rather than avoiding it.
   */
  if (limit === 0) return [];
  if (search.query && context.index && context.vectorBackend) {
    const ranked = await searchViaBackend(
      context,
      context.vectorBackend,
      context.index,
      search,
      signal,
    );
    return ranked.slice(offset, offset + limit);
  }
  if (!search.query || !context.index) {
    const page = await collectCandidates(
      context,
      search,
      { kind: 'page', need: offset + limit },
      signal,
    );
    return page.map(({ item }) => ({ ...item })).slice(offset, offset + limit);
  }
  const candidates = await collectCandidates(
    context,
    search,
    { kind: 'semantic', cap: context.maxSearchCandidates },
    signal,
  );
  const queryVector = await context.index.embeddings.embedQuery(search.query);
  assertVectorDims(context.index, queryVector, 'query');
  const ranked = rankInMemory(candidates, queryVector, context.maxSearchCandidates, (count) =>
    context.logger.warn(
      'search: some candidates carry an embedding of a different dimension than the query and ' +
        'were ranked unscored; re-embed them with reconcileVectorIndex or a re-put',
      { namespacePrefix: truncateLabelsForLog(search.namespacePrefix), count },
    ),
  );
  return ranked.slice(offset, offset + limit);
}
