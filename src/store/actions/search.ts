import type {
  IndexConfig,
  Item,
  SearchItem,
  SearchOperation,
} from '@langchain/langgraph-checkpoint';

import { paginateQuery } from '../../shared/dynamodb/paginate';
import { paginateScan } from '../../shared/dynamodb/scan';
import { type JsonValue, matchesStoreFilter } from '../internal/filter';
import { narrowStoreRecord, readStoreItem } from '../internal/item-mapper';
import { namespaceMatchesPrefix } from '../internal/keys';
import { scopedQuery, storeScan } from '../internal/query';
import { type RankCandidate, rankInMemory } from '../internal/ranker';
import type { StoreContext } from '../internal/setup';
import { validatePaging } from '../internal/validation';
import type { VectorBackend } from '../vector-backend';
import { getItem } from './get';

const DEFAULT_LIMIT = 10;

function passesFilter(item: Item, op: SearchOperation): boolean {
  if (!op.filter) return true;
  return matchesStoreFilter(
    item.value as Record<string, JsonValue>,
    op.filter as Record<string, JsonValue>,
  );
}

async function collectCandidates(
  context: StoreContext,
  op: SearchOperation,
): Promise<RankCandidate[]> {
  const source =
    op.namespacePrefix.length > 0
      ? paginateQuery({
          client: context.client,
          params: scopedQuery(context.tableName, op.namespacePrefix),
        })
      : paginateScan({ client: context.client, params: storeScan(context.tableName) });
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

async function searchViaBackend(
  context: StoreContext,
  backend: VectorBackend,
  index: IndexConfig,
  op: SearchOperation,
  topK: number,
): Promise<SearchItem[]> {
  const queryVector = await index.embeddings.embedQuery(op.query as string);
  const matches = await backend.query(op.namespacePrefix, queryVector, topK);
  const results: SearchItem[] = [];
  for (const match of matches) {
    if (!namespaceMatchesPrefix(match.namespace, op.namespacePrefix)) continue;
    const item = await getItem(context, match.namespace, match.key);
    if (item && passesFilter(item, op)) results.push({ ...item, score: match.score });
  }
  return results;
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
      offset + limit,
    );
    return ranked.slice(offset, offset + limit);
  }
  const candidates = await collectCandidates(context, op);
  if (!op.query || !context.index) {
    return candidates.map(({ item }) => ({ ...item })).slice(offset, offset + limit);
  }
  const queryVector = await context.index.embeddings.embedQuery(op.query);
  return rankInMemory(candidates, queryVector, context.maxSearchCandidates).slice(
    offset,
    offset + limit,
  );
}
