import type { SearchOperation } from '@langchain/langgraph-checkpoint';

import { nowSeconds } from '../../shared/clock';
import { mapWithConcurrency } from '../../shared/concurrency';
import { DEFAULT_READ_CONCURRENCY } from '../../shared/constants';
import { isExpiredRow, withoutExpired } from '../../shared/dynamodb/expiry';
import { paginateQuery } from '../../shared/dynamodb/paginate';
import { retryFor } from '../../shared/dynamodb/retry-policy';
import { paginateScan } from '../../shared/dynamodb/scan';
import type { DocItem } from '../../shared/dynamodb/types';
import { ValidationError } from '../../shared/errors/errors';
import type { StoreItemRecord } from '../types';
import { narrowStoreRecord, readStoreItem } from './item-mapper';
import { namespaceMatchesPrefix } from './keys';
import { scopedQuery, storeScan } from './query';
import type { RankCandidate } from './ranker';
import { passesFilter } from './search-filter';
import type { StoreContext } from './setup';

/**
 * How far a collection must go. A plain page is complete once `need`
 * (`offset + limit`) matching items are in hand, so rows past it are never
 * read or decoded; a semantic ranking needs every candidate but is refused as
 * soon as more than `cap` rows exist, before a single decode or embedding.
 */
export type CollectBound = { kind: 'page'; need: number } | { kind: 'semantic'; cap: number };

/** Rows waiting for a decode batch, and the candidates decoded so far. */
interface Collector {
  pending: StoreItemRecord[];
  collected: RankCandidate[];
}

function candidateSource(
  context: StoreContext,
  op: SearchOperation,
  signal: AbortSignal | undefined,
  now: number,
): AsyncGenerator<DocItem> {
  return op.namespacePrefix.length > 0
    ? paginateQuery({
        retry: retryFor(context, signal),
        signal,
        client: context.client,
        params: withoutExpired(scopedQuery(context.tableName, op.namespacePrefix), now),
        maxItems: context.maxScanItems,
      })
    : paginateScan({
        retry: retryFor(context, signal),
        signal,
        client: context.client,
        params: withoutExpired(storeScan(context.tableName), now),
        maxItems: context.maxScanItems,
      });
}

/** The store record a raw row denotes, or undefined for a foreign, expired or out-of-prefix row. */
function liveRecord(raw: DocItem, op: SearchOperation, now: number): StoreItemRecord | undefined {
  const record = narrowStoreRecord(raw);
  if (!record || isExpiredRow(record, now)) return undefined;
  return namespaceMatchesPrefix(record.namespace, op.namespacePrefix) ? record : undefined;
}

/** Decode the pending rows concurrently (each offloaded row is one S3 GET) and keep the ones passing the filter. */
async function flush(context: StoreContext, op: SearchOperation, state: Collector): Promise<void> {
  if (state.pending.length === 0) return;
  const batch = state.pending;
  state.pending = [];
  const items = await mapWithConcurrency(batch, DEFAULT_READ_CONCURRENCY, (record) =>
    readStoreItem(context, record),
  );
  batch.forEach((record, index) => {
    if (passesFilter(items[index], op)) {
      state.collected.push({ item: items[index], embedding: record.embedding });
    }
  });
}

/**
 * Rows to gather before the next decode. With a filter every batch is a full
 * one, since any row may be dropped; without one every decoded row is a match,
 * so the batch never exceeds what the page still needs.
 */
function batchSize(op: SearchOperation, need: number, collected: number): number {
  return op.filter === undefined
    ? Math.min(DEFAULT_READ_CONCURRENCY, need - collected)
    : DEFAULT_READ_CONCURRENCY;
}

function tooManyCandidates(count: number, cap: number): ValidationError {
  return new ValidationError(
    `Semantic search candidate set (${count}) exceeds maxSearchCandidates (${cap}); ` +
      'use a dedicated VectorBackend for large corpora',
    'maxSearchCandidates',
  );
}

/**
 * Collect the live rows under the prefix and decode them within `bound`. A
 * page decodes rows in batches of {@link DEFAULT_READ_CONCURRENCY} and closes
 * the paginator as soon as the page is full, so a namespace far larger than the
 * page costs neither a full decode nor a truncation error.
 */
export async function collectCandidates(
  context: StoreContext,
  op: SearchOperation,
  bound: CollectBound,
  signal?: AbortSignal,
): Promise<RankCandidate[]> {
  const now = nowSeconds();
  const state: Collector = { pending: [], collected: [] };
  for await (const raw of candidateSource(context, op, signal, now)) {
    const record = liveRecord(raw, op, now);
    if (!record) continue;
    state.pending.push(record);
    if (bound.kind === 'semantic') {
      if (state.pending.length > bound.cap)
        throw tooManyCandidates(state.pending.length, bound.cap);
      continue;
    }
    if (state.pending.length < batchSize(op, bound.need, state.collected.length)) continue;
    await flush(context, op, state);
    if (state.collected.length >= bound.need) return state.collected;
  }
  await flush(context, op, state);
  return state.collected;
}
