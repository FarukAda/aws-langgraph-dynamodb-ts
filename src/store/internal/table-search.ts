/**
 * Hides how a search is served from the table alone.
 *
 * Without a vector backend, a search reads the rows under its prefix within
 * `maxScanItems`, decodes them a batch at a time, keeps the ones its filter
 * passes, and — for a semantic query — ranks them in memory by cosine
 * similarity within `maxSearchCandidates`, an item without an embedding sorting
 * last. How far the read goes before it can stop is decided here.
 */

import type { Item, SearchItem } from '@langchain/langgraph-checkpoint';

import { nowSeconds } from '../../shared/clock';
import { DEFAULT_READ_CONCURRENCY, mapWithConcurrency } from '../../shared/concurrency';
import type { DocItem } from '../../shared/dynamodb/client';
import { paginateQuery, paginateScan } from '../../shared/dynamodb/paginate';
import { retryFor } from '../../shared/dynamodb/retry';
import { isExpiredRow, withoutExpired } from '../../shared/dynamodb/table-schema';
import { DynamoDBLangGraphError } from '../../shared/errors/base-error';
import { ErrorCode } from '../../shared/errors/error-code';
import { validationError } from '../../shared/errors/errors';
import { passesFilter } from './filter';
import type { ParsedSearch } from './parse';
import {
  narrowWholeRecord,
  namespaceMatchesPrefix,
  readStoreItem,
  scopedQuery,
  type StoreItemRecord,
  storeScan,
} from './rows';
import { cosineSimilarity } from './semantic-search';
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

/** Sort weight for an item without an embedding; below the −1 cosine minimum. */
const UNSCORED_RANK = -2;

/** A decoded item plus its stored vectors, awaiting ranking. */
export interface RankCandidate {
  item: Item;
  /**
   * One vector per extracted path. A row written before the store embedded
   * per path carries a single vector and arrives here as a one-element list,
   * which scores identically to how it always did.
   */
  embeddings?: number[][];
}

/**
 * The best cosine similarity across an item's vectors, or undefined when none
 * can be compared. Scoring by the *best* passage rather than by an average is
 * what the reference store does, and it is why a long document with one
 * strongly-matching section is found.
 */
function bestScore(vectors: number[][], queryVector: number[]): number | undefined {
  let best: number | undefined;
  for (const vector of vectors) {
    if (vector.length !== queryVector.length) continue;
    const score = cosineSimilarity(queryVector, vector);
    if (best === undefined || score > best) best = score;
  }
  return best;
}

/** True when the candidate has vectors but none of a comparable length. */
function isDimensionMismatch(candidate: RankCandidate, queryVector: number[]): boolean {
  const vectors = candidate.embeddings;
  return (
    vectors !== undefined &&
    vectors.length > 0 &&
    vectors.every((vector) => vector.length !== queryVector.length)
  );
}

/**
 * Rank candidates by cosine similarity to `queryVector`, descending. Throws a
 * `VALIDATION` when the candidate count exceeds `maxCandidates`
 * (steer large corpora to an external VectorBackend).
 *
 * An item is scored by its best-matching vector, as the reference store scores
 * its per-path embeddings. A stored vector whose length differs from the query
 * vector's cannot be scored — it was written by a different embeddings model —
 * and an item with no comparable vector at all is ranked last with an
 * undefined score. `onDimensionMismatch` is invoked once with how many
 * candidates that affected, so the caller can say so instead of silently
 * returning a ranking that quietly omits them.
 *
 * Accepts: `candidates` — in any order; empty ranks to empty. A candidate with
 * no `embeddings` was never indexed (indexing off at write time, or no
 * indexable text) and one with an empty list is the same thing. `queryVector` —
 * the embedded query; one of a different length than everything stored means
 * the query and the corpus were embedded by different models, and nothing
 * scores.
 *
 * Returns: every candidate, scored and sorted best-first. Nothing is dropped:
 * an unscorable item still belongs to the namespace the caller searched, and
 * dropping it would turn a model mismatch into a silently empty result.
 *
 * Throws: `VALIDATION` naming `maxSearchCandidates` when more candidates
 * arrive than may be ranked in memory — a bound on this process's memory, not
 * on the corpus, which is what a `vectorBackend` is for.
 *
 * Guarantees: ranking reads the vectors only; no item is decoded or fetched
 * again, and `onDimensionMismatch` fires at most once per call.
 */
export function rankInMemory(
  candidates: RankCandidate[],
  queryVector: number[],
  maxCandidates: number,
  onDimensionMismatch?: (count: number) => void,
): SearchItem[] {
  if (candidates.length > maxCandidates) {
    throw validationError(
      `Semantic search candidate set (${candidates.length}) exceeds maxSearchCandidates ` +
        `(${maxCandidates}); use a dedicated VectorBackend for large corpora`,
      'maxSearchCandidates',
    );
  }
  const mismatched = candidates.filter((candidate) =>
    isDimensionMismatch(candidate, queryVector),
  ).length;
  if (mismatched > 0) onDimensionMismatch?.(mismatched);
  return candidates
    .map(({ item, embeddings }) => ({
      ...item,
      score: embeddings ? bestScore(embeddings, queryVector) : undefined,
    }))
    .sort((a, b) => rankValue(b) - rankValue(a));
}

/** Sort weight: real cosine score, or a value below the cosine minimum for unscored items. */
function rankValue(item: SearchItem): number {
  return item.score ?? UNSCORED_RANK;
}
