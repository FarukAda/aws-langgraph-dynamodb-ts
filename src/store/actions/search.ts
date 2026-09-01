import type { SearchItem, SearchOperation } from '@langchain/langgraph-checkpoint';

import { paginateQuery } from '../../shared/dynamodb/paginate';
import { paginateScan } from '../../shared/dynamodb/scan';
import { searchViaBackend } from '../internal/backend-search';
import { narrowStoreRecord, readStoreItem } from '../internal/item-mapper';
import { namespaceMatchesPrefix } from '../internal/keys';
import { scopedQuery, storeScan } from '../internal/query';
import { type RankCandidate, rankInMemory } from '../internal/ranker';
import { passesFilter } from '../internal/search-filter';
import { assertVectorDims } from '../internal/semantic-search';
import type { StoreContext } from '../internal/setup';
import { validatePaging } from '../internal/validation';

const DEFAULT_LIMIT = 10;

async function collectCandidates(
  context: StoreContext,
  op: SearchOperation,
): Promise<RankCandidate[]> {
  const source =
    op.namespacePrefix.length > 0
      ? paginateQuery({
          client: context.client,
          params: scopedQuery(context.tableName, op.namespacePrefix),
          maxItems: context.maxScanItems,
        })
      : paginateScan({
          client: context.client,
          params: storeScan(context.tableName),
          maxItems: context.maxScanItems,
        });
  const candidates: RankCandidate[] = [];
  for await (const raw of source) {
    const record = narrowStoreRecord(raw);
    if (!record) continue;
    if (!namespaceMatchesPrefix(record.namespace, op.namespacePrefix)) continue;
    const item = await readStoreItem(context, record);
    if (!passesFilter(item, op)) continue;
    candidates.push({ item, embedding: record.embedding });
  }
  return candidates;
}

/**
 * Search items under a namespace prefix: metadata filtering plus optional
 * semantic ranking. A non-empty prefix uses a native Query; an empty prefix
 * falls back to a (filtered) Scan. Semantic ranking uses the configured
 * VectorBackend when present, else an in-memory cosine ranking (capped).
 */
export async function searchItems(
  context: StoreContext,
  op: SearchOperation,
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
    );
    return ranked.slice(offset, offset + limit);
  }
  const candidates = await collectCandidates(context, op);
  if (!op.query || !context.index) {
    return candidates.map(({ item }) => ({ ...item })).slice(offset, offset + limit);
  }
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
