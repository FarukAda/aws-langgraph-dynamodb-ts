import type { SearchItem, SearchOperation } from '@langchain/langgraph-checkpoint';

import { searchViaBackend } from '../internal/backend-search';
import { collectCandidates } from '../internal/candidates';
import { rankInMemory } from '../internal/ranker';
import { assertVectorDims } from '../internal/semantic-search';
import type { StoreContext } from '../internal/setup';
import { validatePaging } from '../internal/validation';

const DEFAULT_LIMIT = 10;

/**
 * Search items under a namespace prefix: metadata filtering plus optional
 * semantic ranking.
 *
 * Accepts: `op.namespacePrefix` — empty spans the whole table. `op.query` —
 * absent, or empty (which is absent: there is no query to embed), ranks
 * nothing and returns the page as read, which is what the reference store does
 * (`@langchain/langgraph-checkpoint@1.1.5` `dist/store/memory.js:70-80`, where a
 * falsy query takes the unscored path). A query without a configured `index`
 * does the same, since there is nothing to embed it with. `op.offset` and
 * `op.limit` — non-negative integers, defaulting to 0 and
 * {@link DEFAULT_LIMIT}, the reference's default page size.
 *
 * Returns: at most `limit` items from `offset`. With a query and an index every
 * item carries a `score`; without one none does. Scores rank best-first; an item
 * that cannot be scored ranks last rather than being dropped.
 *
 * Throws: ValidationError naming `offset`, `limit`, `maxSearchCandidates` or
 * `index.dims`; whatever the reads, decodes and the embeddings model throw.
 *
 * Guarantees: only the page's own items are decoded on the unranked path — the
 * read stops as soon as it is full. A semantic search must read every candidate
 * to rank it, which is why it is capped and why a large corpus belongs in a
 * `vectorBackend`.
 */
export async function searchItems(
  context: StoreContext,
  op: SearchOperation,
  signal?: AbortSignal,
): Promise<SearchItem[]> {
  const offset = op.offset ?? 0;
  const limit = op.limit ?? DEFAULT_LIMIT;
  validatePaging(offset, limit);
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
      { namespacePrefix: op.namespacePrefix, count },
    ),
  );
  return ranked.slice(offset, offset + limit);
}
