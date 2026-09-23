import { nowSeconds } from '../../shared/clock';
import { mapWithConcurrency } from '../../shared/concurrency';
import { DEFAULT_READ_CONCURRENCY } from '../../shared/constants';
import type { DocItem } from '../../shared/dynamodb/client';
import { paginateQuery } from '../../shared/dynamodb/paginate';
import { retryFor } from '../../shared/dynamodb/retry-policy';
import { paginateScan } from '../../shared/dynamodb/scan';
import { isExpiredRow, withoutExpired } from '../../shared/dynamodb/table-schema';
import { DynamoDBLangGraphError } from '../../shared/errors/base-error';
import { ErrorCode } from '../../shared/errors/error-code';
import { validationError } from '../../shared/errors/errors';
import type { StoreItemRecord } from '../types';
import { narrowWholeRecord, readStoreItem } from './item-mapper';
import { namespaceMatchesPrefix } from './keys';
import type { ParsedSearch } from './parse';
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

/**
 * The vectors a row carries, whichever shape it was written in: a list of
 * per-path vectors, or the single joined vector of an earlier version read as
 * a one-element list so it ranks as it always did.
 */
function storedVectors(record: StoreItemRecord): number[][] | undefined {
  if (record.embeddings) return record.embeddings;
  return record.embedding ? [record.embedding] : undefined;
}

/** Rows waiting for a decode batch, and the candidates decoded so far. */
interface Collector {
  pending: StoreItemRecord[];
  collected: RankCandidate[];
}

function candidateSource(
  context: StoreContext,
  search: ParsedSearch,
  signal: AbortSignal | undefined,
  now: number,
): AsyncGenerator<DocItem> {
  return search.namespacePrefix.length > 0
    ? paginateQuery({
        retry: retryFor(context, signal),
        signal,
        client: context.client,
        params: withoutExpired(scopedQuery(context.tableName, search.namespacePrefix), now),
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

/** The store record a raw row denotes, or undefined for a foreign, malformed, expired or out-of-prefix row. */
function liveRecord(raw: DocItem, search: ParsedSearch, now: number): StoreItemRecord | undefined {
  const record = narrowWholeRecord(raw);
  if (!record || isExpiredRow(record, now)) return undefined;
  return namespaceMatchesPrefix(record.namespace, search.namespacePrefix) ? record : undefined;
}

/** Decode the pending rows concurrently (each offloaded row is one S3 GET) and keep the ones passing the filter. */
async function flush(
  context: StoreContext,
  search: ParsedSearch,
  state: Collector,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (state.pending.length === 0) return;
  const batch = state.pending;
  state.pending = [];
  const items = await mapWithConcurrency(
    batch,
    context.readConcurrency ?? DEFAULT_READ_CONCURRENCY,
    (record) => readStoreItem(context, record, signal),
  );
  batch.forEach((record, index) => {
    if (passesFilter(items[index], search.filter)) {
      state.collected.push({ item: items[index], embeddings: storedVectors(record) });
    }
  });
}

/**
 * Rows to gather before the next decode. With a filter every batch is a full
 * one, since any row may be dropped; without one every decoded row is a match,
 * so the batch never exceeds what the page still needs.
 */
function batchSize(search: ParsedSearch, need: number, collected: number, limit: number): number {
  return search.filter === undefined ? Math.min(limit, need - collected) : limit;
}

function tooManyCandidates(
  count: number,
  cap: number,
): DynamoDBLangGraphError<ErrorCode.VALIDATION> {
  return validationError(
    `Semantic search candidate set (${count}) exceeds maxSearchCandidates (${cap}); ` +
      'use a dedicated VectorBackend for large corpora',
    'maxSearchCandidates',
  );
}

/**
 * Collect the live rows under the prefix and decode them within `bound`.
 *
 * Accepts: `search.namespacePrefix` — a non-empty prefix is a Query on one
 * partition; an empty one spans every partition and is the Scan this adapter
 * reserves for exactly that (`test/static/guards/scan-sites.ts`). `bound` — a
 * page stops as soon as
 * `need` matching items are in hand; a semantic collection needs every
 * candidate and is refused past `cap`. `search.filter` — applied after decoding,
 * since the filter reads the value.
 *
 * Returns: the matching candidates with the vectors their rows carry, in the
 * order read: sort-key order within a partition, unspecified across partitions.
 * A page therefore pages stably within a namespace, and only there.
 *
 * Throws: `VALIDATION` naming `maxSearchCandidates` before any decode when a
 * semantic collection exceeds `cap`; `RESULT_TRUNCATED` when
 * `maxScanItems` is reached while rows remain — a search never silently answers
 * from part of the table; `ABORTED` when the signal fires between pages;
 * whatever a decode throws for a corrupt or unreadable row.
 *
 * Guarantees: a page closes the paginator as soon as it is full, so a namespace
 * far larger than the page costs neither a full decode nor a truncation error.
 * The bound is tested after a row is in hand, not before one is asked for, so
 * a `need` of 0 would still cost one request; `searchItems` answers that case
 * ahead of this call rather than letting it be paid here.
 * Expired rows, rows of other adapters, rows carrying none of the timestamps a
 * decoded item reports, and rows whose own `namespace` does not match the
 * prefix are all skipped — the last matters because a Scan has no key condition
 * at all, so the prefix is enforced here rather than by DynamoDB, and the one
 * before it because a single such row must not cost a search its other results.
 */
export async function collectCandidates(
  context: StoreContext,
  search: ParsedSearch,
  bound: CollectBound,
  signal?: AbortSignal,
): Promise<RankCandidate[]> {
  const now = nowSeconds();
  const limit = context.readConcurrency ?? DEFAULT_READ_CONCURRENCY;
  const state: Collector = { pending: [], collected: [] };
  for await (const raw of candidateSource(context, search, signal, now)) {
    const record = liveRecord(raw, search, now);
    if (!record) continue;
    state.pending.push(record);
    if (bound.kind === 'semantic') {
      if (state.pending.length > bound.cap)
        throw tooManyCandidates(state.pending.length, bound.cap);
      continue;
    }
    if (state.pending.length < batchSize(search, bound.need, state.collected.length, limit)) {
      continue;
    }
    await flush(context, search, state, signal);
    if (state.collected.length >= bound.need) return state.collected;
  }
  await flush(context, search, state, signal);
  return state.collected;
}
