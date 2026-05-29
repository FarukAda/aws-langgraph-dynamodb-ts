import type { Item, SearchItem, SearchOperation } from '@langchain/langgraph-checkpoint';

import { paginateScan } from '../../shared/dynamodb/scan';
import { type JsonValue, matchesStoreFilter } from '../internal/filter';
import { readStoreItem } from '../internal/item-mapper';
import { namespaceMatchesPrefix } from '../internal/keys';
import { cosineSimilarity } from '../internal/semantic-search';
import type { StoreContext } from '../internal/setup';
import type { StoreItemRecord } from '../types';

const DEFAULT_LIMIT = 10;

interface Candidate {
  item: Item;
  embedding?: number[];
}

async function collectCandidates(context: StoreContext, op: SearchOperation): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for await (const raw of paginateScan({
    client: context.client,
    params: {
      TableName: context.tableName,
      FilterExpression: 'attribute_exists(#ns)',
      ExpressionAttributeNames: { '#ns': 'namespace' },
    },
  })) {
    const record = raw as StoreItemRecord;
    if (!record.namespace) continue;
    if (!namespaceMatchesPrefix(record.namespace, op.namespacePrefix)) continue;
    const item = await readStoreItem(context, record);
    if (
      op.filter &&
      !matchesStoreFilter(
        item.value as Record<string, JsonValue>,
        op.filter as Record<string, JsonValue>,
      )
    ) {
      continue;
    }
    candidates.push({ item, embedding: record.embedding });
  }
  return candidates;
}

async function rank(
  context: StoreContext,
  candidates: Candidate[],
  query: string,
): Promise<SearchItem[]> {
  if (!context.index) return candidates.map(({ item }) => ({ ...item }));
  const queryVector = await context.index.embeddings.embedQuery(query);
  return candidates
    .map(({ item, embedding }) => ({
      ...item,
      score: embedding ? cosineSimilarity(queryVector, embedding) : 0,
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Search items under a namespace prefix: metadata filtering plus optional
 * semantic ranking by the query's embedding similarity, with offset/limit.
 */
export async function searchItems(
  context: StoreContext,
  op: SearchOperation,
): Promise<SearchItem[]> {
  const offset = op.offset ?? 0;
  const limit = op.limit ?? DEFAULT_LIMIT;
  const candidates = await collectCandidates(context, op);
  const ranked = op.query
    ? await rank(context, candidates, op.query)
    : candidates.map(({ item }) => ({ ...item }));
  return ranked.slice(offset, offset + limit);
}
