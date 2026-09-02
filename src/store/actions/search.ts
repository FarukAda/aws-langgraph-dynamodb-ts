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
 * semantic ranking. A non-empty prefix uses a native Query; an empty prefix
 * falls back to a (filtered) Scan. Semantic ranking uses the configured
 * VectorBackend when present, else an in-memory cosine ranking (capped).
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
