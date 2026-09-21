import type { SearchItem, SearchOperation } from '@langchain/langgraph-checkpoint';

import { truncateLabelsForLog } from '../../shared/logging/truncate';
import { searchViaBackend } from '../internal/backend-search';
import { collectCandidates } from '../internal/candidates';
import { assertSearchOperation } from '../internal/operation-validation';
import { rankInMemory } from '../internal/ranker';
import { assertVectorDims } from '../internal/semantic-search';
import type { StoreContext } from '../internal/setup';

const DEFAULT_LIMIT = 10;

/**
 * Search items under a namespace prefix: metadata filtering plus optional
 * semantic ranking.
 *
 * Accepts: `op.namespacePrefix` — labels a namespace can hold; empty spans the
 * whole table. `op.filter` — absent or an object. `op.query` —
 * absent, or empty (which is absent: there is no query to embed), ranks
 * nothing and returns the page as read, which is what the reference store does
 * (`@langchain/langgraph-checkpoint@1.1.5` `dist/store/memory.js:70-80`, where a
 * falsy query takes the unscored path). A query without a configured `index`
 * does the same, since there is nothing to embed it with. `op.offset` and
 * `op.limit` — non-negative integers, defaulting to 0 and
 * {@link DEFAULT_LIMIT}, the reference's default page size. A `limit` of 0
 * returns an empty page before any path issues a read.
 *
 * Returns: at most `limit` items from `offset`. With a query and an index every
 * item carries a `score`; without one none does. Scores rank best-first; an item
 * that cannot be scored ranks last rather than being dropped.
 *
 * Throws: ValidationError naming `namespacePrefix`, `namespacePrefix element`,
 * `offset`, `limit`, `maxSearchCandidates`, `index.dims`, `filter` or `query`;
 * whatever the reads, decodes and the embeddings model throw.
 *
 * Guarantees: a page of zero costs no request at all, and otherwise only the
 * page's own items are decoded on the unranked path — the
 * read stops as soon as it is full. A semantic search must read every candidate
 * to rank it, which is why it is capped and why a large corpus belongs in a
 * `vectorBackend`.
 */
export async function searchItems(
  context: StoreContext,
  op: SearchOperation,
  signal?: AbortSignal,
): Promise<SearchItem[]> {
  assertSearchOperation(op);
  const offset = op.offset ?? 0;
  const limit = op.limit ?? DEFAULT_LIMIT;
  /**
   * A zero page is answered here, ahead of all three paths below, because each
   * of them pays for it: `collectCandidates` pulls the first row out of the
   * paginator before it tests its `offset + limit` bound, so even a page that
   * needs nothing costs one Query or Scan, and the two ranked paths embed the
   * query as well. Slicing the result to nothing afterwards hid the cost
   * rather than avoiding it.
   */
  if (limit === 0) return [];
  if (op.query && context.index && context.vectorBackend) {
    const ranked = await searchViaBackend(
      context,
      context.vectorBackend,
      context.index,
      op,
      offset,
      limit,
      signal,
    );
    return ranked.slice(offset, offset + limit);
  }
  if (!op.query || !context.index) {
    const page = await collectCandidates(
      context,
      op,
      { kind: 'page', need: offset + limit },
      signal,
    );
    return page.map(({ item }) => ({ ...item })).slice(offset, offset + limit);
  }
  const candidates = await collectCandidates(
    context,
    op,
    { kind: 'semantic', cap: context.maxSearchCandidates },
    signal,
  );
  const queryVector = await context.index.embeddings.embedQuery(op.query);
  assertVectorDims(context.index, queryVector, 'query');
  const ranked = rankInMemory(candidates, queryVector, context.maxSearchCandidates, (count) =>
    context.logger.warn(
      'search: some candidates carry an embedding of a different dimension than the query and ' +
        'were ranked unscored; re-embed them with reconcileVectorIndex or a re-put',
      { namespacePrefix: truncateLabelsForLog(op.namespacePrefix), count },
    ),
  );
  return ranked.slice(offset, offset + limit);
}
