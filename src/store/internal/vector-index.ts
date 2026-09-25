/**
 * Hides the vector backend as a copy of the items' embeddings.
 *
 * When a store is given a `VectorBackend`, every item's embedding is kept there
 * as well as the item in the table, and the table is the truth. When the copy
 * is written (after the row commits), when an entry is dropped (only once a
 * fresh read finds the row gone), how a backend's answer is resolved back to
 * the canonical items and in which direction its scores run, and how the copy
 * is repaired against the table are decided here, and nothing else calls the
 * backend.
 */

import type { IndexConfig, Item, SearchItem } from '@langchain/langgraph-checkpoint';

import { nowSeconds } from '../../shared/clock';
import { DEFAULT_READ_CONCURRENCY, mapWithConcurrency } from '../../shared/concurrency';
import { isRowAbsent } from '../../shared/dynamodb/idempotent-write';
import { paginateQuery } from '../../shared/dynamodb/paginate';
import { retryFor } from '../../shared/dynamodb/retry';
import { isExpiredRow, withoutExpired } from '../../shared/dynamodb/table-schema';
import { failureLabel } from '../../shared/errors/base-error';
import { validationError } from '../../shared/errors/errors';
import { truncateForLog, truncateLabelsForLog } from '../../shared/logging/truncate';
import type { VectorReconcileResult } from '../types';
import type {
  VectorBackend,
  VectorMatch,
  VectorRef,
  VectorScoreDirection,
} from '../vector-backend';
import type { JsonValue } from './filter';
import { passesFilter } from './filter';
import { getItem } from './get-item';
import {
  type Namespace,
  type ParsedPut,
  type ParsedSearch,
  parseStoreAddress,
  type StoreAddress,
} from './parse';
import {
  itemRowKey,
  namespaceMatchesPrefix,
  parseWholeStoreRow,
  readStoreItem,
  scopedQuery,
  type StoreItemRecord,
} from './rows';
import { assertVectorDims, embedValue, embedValues } from './semantic-search';
import type { StoreContext } from './setup';

/** A store context whose vector copy is configured: an embeddings index and a backend. */
export type BackendContext = StoreContext & {
  readonly index: IndexConfig;
  readonly vectorBackend: VectorBackend;
};

/**
 * Whether the store keeps a vector copy.
 *
 * Accepts: `context` — the store's.
 *
 * Returns: `true`, narrowing `context`, when both `index` and `vectorBackend`
 * are configured.
 *
 * Throws: nothing.
 */
export function hasVectorBackend(context: StoreContext): context is BackendContext {
  return context.index !== undefined && context.vectorBackend !== undefined;
}

/**
 * The one vector a put gives the backend for its item.
 *
 * Accepts: `op` — the parsed put. Its `index` is `false` to embed nothing, a
 * field list to embed those fields, absent to embed the configured ones.
 *
 * Returns: the joined embedding, or `undefined` when the store keeps no vector
 * copy, the put indexes nothing, or the value has no text to embed.
 *
 * Throws: `VALIDATION` naming `index.dims` when the model returns a vector of
 * another length; whatever `embedDocuments` throws.
 */
export async function itemVector(
  context: StoreContext,
  op: ParsedPut,
): Promise<number[] | undefined> {
  if (!context.vectorBackend || op.index === false) return undefined;
  return embedValue(context, op.value, op.index);
}

/**
 * Write an item's entry in the vector copy after its row has committed: the
 * vector when there is one, a delete when there is none. Best-effort sync of
 * one item's embedding to the vector backend after the canonical DynamoDB
 * write has already succeeded.
 *
 * Accepts: `address` — the item's. `embedding` — from {@link itemVector}:
 * present upserts it; absent deletes any vector the backend still holds, which
 * is what a re-put with no indexable text, an `index: false` put and a delete
 * all mean.
 *
 * Returns: nothing, in both the synced and the failed case; without a backend,
 * nothing is done.
 *
 * Throws: nothing. The canonical item is already committed, so failing here
 * would report a put that in fact succeeded; the drift is logged at `warn` and
 * `reconcileVectorIndex` repairs it.
 */
export async function syncItemVector(
  context: StoreContext,
  address: StoreAddress,
  embedding: number[] | undefined,
): Promise<void> {
  const backend = context.vectorBackend;
  if (backend === undefined) return;
  try {
    if (embedding) await backend.upsert(address.namespace, address.key, embedding);
    else await backend.delete(address.namespace, address.key);
  } catch (error) {
    // The name, not the message: a backend's error text is not an identifier.
    // Bounded all the same — the name is the backend's own and nothing this
    // package ran checked its length, and `message` is bounded where
    // `redactedMessage` relays it, so relaying the name whole would split what
    // is one value. The literal does not name a method, because both
    // `store.put` and `store.delete` reach here and reporting a failed delete
    // as a failed put sends an operator to the wrong call site; `operation`
    // carries which one.
    context.logger.warn('store vector-index sync failed; reconcileVectorIndex will repair', {
      namespace: address.namespace,
      key: address.key,
      operation: embedding ? 'upsert' : 'delete',
      reason: truncateForLog(failureLabel(error as Error)),
    });
  }
}

/**
 * Drop the item's vector, but only on a fresh read that finds no row at the
 * key.
 *
 * The question is deliberately **not** "did this call remove the row" — that
 * one is true in exactly the interleaving that goes wrong. It is "does the key
 * hold a row *now*", which a racing put that recreated it and a
 * compare-and-swap that left it alone both answer the same way, and which costs
 * a point read of this library's own table rather than anything the backend has
 * to offer. The reconciler asks the same question before pruning a vector, so
 * the delete path and the reconciler are equally careful.
 *
 * A read that itself fails answers "not confirmed" and keeps the vector: a
 * stale vector for a deleted item, which `reconcileVectorIndex` removes, rather
 * than a missing one for a live item, which is the defect this exists for.
 *
 * Accepts: `address` — the deleted item's; the row read is derived from it.
 *
 * Returns: nothing; without a backend, nothing is read or dropped. A row still
 * at the key keeps its vector and logs one `info`.
 *
 * Throws: nothing the backend throws (see {@link syncItemVector}); whatever the
 * confirmation read throws that `isRowAbsent` does not answer as "not
 * confirmed".
 */
export async function dropVectorWhenGone(
  context: StoreContext,
  address: StoreAddress,
): Promise<void> {
  if (context.vectorBackend === undefined) return;
  const key = itemRowKey(address);
  if (!(await isRowAbsent(context, key))) {
    context.logger.info('store.delete: kept a vector whose item was not confirmed gone', {
      namespace: address.namespace,
      key: address.key,
    });
    return;
  }
  await syncItemVector(context, address, undefined);
}

/** A canonical item's location plus the embedding recomputed for it. */
export interface ReconcileTarget {
  namespace: string[];
  key: string;
  embedding: number[] | undefined;
}

/** A live item read back from DynamoDB, awaiting its embedding. */
type LiveItem = Pick<ReconcileTarget, 'namespace' | 'key'> & { value: Record<string, JsonValue> };

/** Stable, collision-free identity for a (namespace, key) pair. */
function refIdentity(namespace: string[], key: string): string {
  return JSON.stringify([...namespace, key]);
}

/** Decode the buffered rows with the same bounded concurrency the search path uses. */
async function drainPending(
  context: StoreContext,
  pending: StoreItemRecord[],
  live: LiveItem[],
  signal: AbortSignal | undefined,
): Promise<void> {
  if (pending.length === 0) return;
  const batch = pending.splice(0, pending.length);
  const items = await mapWithConcurrency(
    batch,
    context.readConcurrency ?? DEFAULT_READ_CONCURRENCY,
    (record) => readStoreItem(context, record, signal),
  );
  batch.forEach((record, index) => {
    live.push({
      namespace: record.namespace,
      key: record.key,
      value: items[index].value as Record<string, JsonValue>,
    });
  });
}

/**
 * Enumerate the live (unexpired) items under `prefix` and recompute their
 * embeddings.
 *
 * Accepts: `prefix` — at least one element, since the enumeration is one
 * partition's Query; reconciling is always scoped. `signal` — aborts between
 * pages.
 *
 * Returns: one target per live item, each with the embedding the item's current
 * value produces — `undefined` when it yields no indexable text, which is the
 * evidence that lets {@link pruneOrphans} drop a vector that has gone stale.
 *
 * Throws: whatever the reads, the decodes and the embeddings model throw; a
 * failed embedding rejects the whole reconcile, because a skipped item would
 * leave the live set and {@link selectOrphans} would prune its still-valid
 * vector. `RESULT_TRUNCATED` when `maxScanItems` is reached while rows
 * remain — reconciling from a partial view would prune live vectors.
 *
 * Guarantees: rows are decoded in bounded batches, so a namespace of offloaded
 * items costs neither one round-trip at a time nor every payload in memory at
 * once.
 */
export async function collectReconcileTargets(
  context: StoreContext,
  prefix: Namespace,
  signal?: AbortSignal,
): Promise<ReconcileTarget[]> {
  const now = nowSeconds();
  const live: LiveItem[] = [];
  const pending: StoreItemRecord[] = [];
  const batchLimit = context.readConcurrency ?? DEFAULT_READ_CONCURRENCY;
  const source = paginateQuery({
    retry: retryFor(context, signal),
    signal,
    client: context.client,
    params: withoutExpired(scopedQuery(context.tableName, prefix), now),
    maxItems: context.maxScanItems,
  });
  for await (const raw of source) {
    const record = parseWholeStoreRow(raw);
    if (!record) {
      context.logger.warn('reconcileVectorIndex: skipped a row that is not a store item', {
        sortKey: truncateForLog(raw.SK as string),
      });
      continue;
    }
    if (isExpiredRow(record, now) || !namespaceMatchesPrefix(record.namespace, prefix)) continue;
    pending.push(record);
    if (pending.length >= batchLimit) await drainPending(context, pending, live, signal);
  }
  await drainPending(context, pending, live, signal);
  const embeddings = await embedValues(
    context,
    live.map((entry) => entry.value),
  );
  return live.map((entry, i) => ({
    namespace: entry.namespace,
    key: entry.key,
    embedding: embeddings[i],
  }));
}

/**
 * Re-push every live embedding to the backend.
 *
 * Accepts: `targets` — a target with no embedding is not pushed; its vector is
 * {@link pruneOrphans}' business, not an upsert of nothing.
 *
 * Returns: how many vectors were upserted.
 *
 * Throws: whatever the backend throws. The upserts are issued one at a time on
 * purpose: this is a bulk repair against a third-party index, and the run has
 * no latency budget worth a thundering herd.
 */
export async function pushEmbeddings(
  backend: VectorBackend,
  targets: ReconcileTarget[],
): Promise<number> {
  let upserted = 0;
  for (const target of targets) {
    if (!target.embedding) continue;
    await backend.upsert(target.namespace, target.key, target.embedding);
    upserted += 1;
  }
  return upserted;
}

/**
 * Refs the backend holds that the live set does not account for.
 *
 * Accepts: `backendRefs` — whatever the backend lists under the prefix.
 * `live` — the snapshot; a target with no embedding does not account for a
 * vector, since its item no longer produces one.
 *
 * Returns: the candidates to prune — candidates, not conclusions: the snapshot
 * and the backend listing are not one point in time (see {@link pruneOrphans}).
 *
 * Throws: nothing.
 */
export function selectOrphans(backendRefs: VectorRef[], live: ReconcileTarget[]): VectorRef[] {
  const liveKeys = new Set(
    live
      .filter((target) => target.embedding !== undefined)
      .map((target) => refIdentity(target.namespace, target.key)),
  );
  return backendRefs.filter((ref) => !liveKeys.has(refIdentity(ref.namespace, ref.key)));
}

/**
 * True when a candidate's canonical item is confirmed absent right now. The
 * live-set snapshot and this read are not one point in time, so an item
 * written between them looks orphaned even though it is live — and deleting
 * its vector would silently drop a just-written item out of semantic search.
 */
async function confirmedGone(context: StoreContext, ref: VectorRef): Promise<boolean> {
  return isRowAbsent(context, itemRowKey(ref));
}

/**
 * Delete backend vectors with no canonical item.
 *
 * Accepts: `live` — the snapshot {@link collectReconcileTargets} took.
 * `backend.listKeys` — optional; a backend that cannot enumerate its own keys
 * cannot be pruned, which is reported rather than silently skipped.
 *
 * Returns: how many vectors were deleted.
 *
 * Throws: whatever the backend and the confirmation read throw.
 *
 * Guarantees: a vector is deleted only on evidence that its item is gone — the
 * snapshot saw the item and it yields no embedding, or a fresh
 * strongly-consistent read finds no row at all. An item written between the
 * snapshot and the listing looks orphaned and is kept, so reconciling never
 * drops a just-written item out of semantic search.
 */
export async function pruneOrphans(
  context: StoreContext,
  backend: VectorBackend,
  prefix: Namespace,
  live: ReconcileTarget[],
): Promise<number> {
  if (!backend.listKeys) {
    context.logger.info('reconcileVectorIndex prune skipped: backend has no listKeys', {
      prefix: truncateLabelsForLog(prefix),
    });
    return 0;
  }
  const candidates = selectOrphans(await backend.listKeys(prefix), live);
  /**
   * Every item the snapshot actually saw, embedded or not. A candidate in here
   * is prunable on the evidence already gathered — its item exists but yields
   * no embedding (its indexable text became empty), so its vector really is
   * stale. Only a candidate the snapshot never saw at all is ambiguous.
   */
  const observed = new Set(live.map((target) => refIdentity(target.namespace, target.key)));
  let pruned = 0;
  for (const ref of candidates) {
    const seen = observed.has(refIdentity(ref.namespace, ref.key));
    if (!seen && !(await confirmedGone(context, ref))) {
      // The ref is a consumer backend's answer, bounded by nothing this package ran.
      context.logger.info('reconcileVectorIndex: kept a vector whose item reappeared', {
        namespace: truncateLabelsForLog(ref.namespace),
        key: truncateForLog(ref.key),
      });
      continue;
    }
    await backend.delete(ref.namespace, ref.key);
    pruned += 1;
  }
  return pruned;
}

/**
 * Repair the vector copy against the items under a prefix: re-push every live
 * embedding, then prune entries whose item is confirmed gone.
 *
 * Accepts: `prefix` — parsed. `signal` — cancels the table read.
 *
 * Returns: how many entries were upserted and pruned.
 *
 * Throws: whatever the table read, the embeddings model or the backend throws.
 */
export async function reconcileVectors(
  context: BackendContext,
  prefix: Namespace,
  signal?: AbortSignal,
): Promise<VectorReconcileResult> {
  const targets = await collectReconcileTargets(context, prefix, signal);
  const upserted = await pushEmbeddings(context.vectorBackend, targets);
  const pruned = await pruneOrphans(context, context.vectorBackend, prefix, targets);
  return { upserted, pruned };
}

/**
 * Warn when a backend's own ordering disagrees with its scores. A backend
 * returning a raw distance still hands back nearest-first, so the order looks
 * right while every score means the opposite of what {@link VectorMatch.score}
 * promises — ascending scores are that exact signature. Results are never
 * reordered on this basis: a correctly-scored backend's order is authoritative.
 */
function warnOnNonDescendingScores(
  context: StoreContext,
  matches: VectorMatch[],
  namespacePrefix: string[],
): void {
  const descending = matches.every(
    (match, position) => position === 0 || matches[position - 1].score >= match.score,
  );
  if (descending) return;
  context.logger.warn(
    'search: vectorBackend returned ascending scores; VectorMatch.score must be a relevance ' +
      '(higher is better), not a distance — results are forwarded in the order the backend gave',
    { namespacePrefix: truncateLabelsForLog(namespacePrefix) },
  );
}

/**
 * The address a backend match names, parsed, or `undefined` — logged — when it
 * names one this store cannot form. A backend returning a namespace element
 * that holds the reserved separator would otherwise turn a whole search into a
 * `VALIDATION` error over one bad key. The address is checked here rather than
 * read back off the error `getItem` raises: the read raises a `VALIDATION` error
 * of its own for a payload it cannot honour — an offloaded row read with no
 * `s3` configured, a descriptor that is not one, an `s3Key` outside the row's
 * path — and those are reads that did not happen, not items that are not
 * there, so telling them apart by code alone dropped them as well.
 *
 * The line quotes the address the backend gave, bounded: this fires in the
 * branch where `parseStoreAddress` refused it, one line per bad match, and
 * nothing this package ran bounded either the labels or how many of them there
 * are. The `reason` goes through the same cap, though it is the only one of
 * these that cannot exceed it: what this `catch` binds is always
 * `parseStoreAddress`'s own `VALIDATION` error, whose code is a literal of this
 * package's. It is cut anyway so the rule reads the same at every site that
 * names a failure — a name and a message are the two halves of what the
 * failure was, and `message` is bounded where `redactedMessage` relays it —
 * and so that a later refusal thrown from somewhere else does not arrive
 * unbounded because this one site was reasoned about individually.
 */
function addressOf(context: StoreContext, match: VectorMatch): StoreAddress | undefined {
  try {
    return parseStoreAddress(match.namespace, match.key);
  } catch (error) {
    context.logger.warn('search: skipped an unusable vectorBackend match', {
      namespace: truncateLabelsForLog(match.namespace),
      key: truncateForLog(match.key),
      reason: truncateForLog(failureLabel(error as Error)),
    });
    return undefined;
  }
}

/**
 * Read the canonical item a backend match points at, or `null` when the match
 * names an address this store cannot form (see {@link addressOf}).
 *
 * Every failure of the read itself reaches the caller. A throttled or cancelled
 * read says nothing about whether the item is there, so treating it as an
 * absent match handed back a page silently one item short, with only a `warn`
 * the default logger never prints to say so — while the in-DynamoDB path fails
 * the same search outright.
 */
async function fetchMatch(
  context: StoreContext,
  match: VectorMatch,
  signal?: AbortSignal,
): Promise<Item | null> {
  const address = addressOf(context, match);
  if (address === undefined) return null;
  return getItem(context, address, signal);
}

/** Stable, collision-free identity for a match, so one call reads each item once. */
function matchIdentity(match: VectorMatch): string {
  return JSON.stringify([match.namespace, match.key]);
}

/**
 * Read the canonical item behind every match this call has not read yet, into
 * `fetched`.
 *
 * Each round asks the backend for a larger `topK`, and the answer *contains*
 * the previous round's matches, so re-reading them cost one DynamoDB read — and
 * one S3 download for an offloaded item — per match per round. Remembering the
 * reads bounds a whole search at one read per distinct match. The same map also
 * covers a backend that returns one key twice in a single round.
 *
 * What a caller trades for it: an item changed between two rounds is answered
 * from the first read. A search is not a transaction and the rounds are
 * milliseconds apart, so the alternative — re-reading to catch a write that may
 * as well have landed a moment later — buys nothing.
 */
async function fetchUnseen(
  context: StoreContext,
  scoped: readonly VectorMatch[],
  fetched: Map<string, Item | null>,
  signal?: AbortSignal,
): Promise<void> {
  const unseen = new Map<string, VectorMatch>();
  for (const match of scoped) {
    const identity = matchIdentity(match);
    if (!fetched.has(identity)) unseen.set(identity, match);
  }
  const pending = [...unseen.values()];
  const items = await mapWithConcurrency(
    pending,
    context.readConcurrency ?? DEFAULT_READ_CONCURRENCY,
    (match) => fetchMatch(context, match, signal),
  );
  pending.forEach((match, index) => fetched.set(matchIdentity(match), items[index]));
}

/**
 * Rank a search through a configured vector backend.
 *
 * Accepts: `context` — the store's, with the backend searched and the index
 * whose embeddings model embeds the query. `search.query` — non-empty; the
 * caller checks that before choosing this path. `search.offset`/`search.limit`
 * — the page, whose end (`offset + limit`) must fit within
 * `maxSearchCandidates`, since that many matches have to be fetched to fill it.
 * `search.filter` — applied to the canonical item, not to whatever the backend
 * stored, so a filter is never answered from a stale vector.
 *
 * Returns: the page's items in the backend's order, each carrying the relevance
 * score for its vector. Fewer than `limit` items means the backend has no more
 * matches under the prefix, not that the page was cut short.
 *
 * Throws: `VALIDATION` naming `index.dims` when the query embeds to a
 * different width than the index declares, and naming `maxSearchCandidates`
 * either for a page larger than the cap or when the filter leaves the page short
 * at the cap — the same answer the in-DynamoDB ranker gives, rather than a
 * silently short page. Whatever a canonical read throws — a read that did not
 * happen is not an item that is not there — since a match this store cannot
 * address is dropped before its read rather than caught after it (see
 * {@link addressOf}). Whatever the embeddings model and the backend throw.
 *
 * Guarantees: DynamoDB stays canonical. A match whose item has since been
 * deleted or lies outside the prefix is dropped and the search asks the backend
 * for more, so a stale or over-broad index costs results only in latency. A
 * match whose read *fails* is not dropped: the page a caller receives is never
 * shorter than the matches that exist, which is what the in-DynamoDB path
 * already promises. Items are fetched with the same bounded concurrency as the
 * in-DynamoDB path, and each distinct match is read once for the whole call
 * however many rounds it takes (see {@link fetchUnseen}).
 */
export async function searchViaBackend(
  context: BackendContext,
  search: ParsedSearch,
  signal?: AbortSignal,
): Promise<SearchItem[]> {
  const backend = context.vectorBackend;
  const index = context.index;
  const { offset, limit } = search;
  const queryVector = await index.embeddings.embedQuery(search.query as string);
  assertVectorDims(index, queryVector, 'query');
  const need = offset + limit;
  if (need > context.maxSearchCandidates) {
    throw validationError(
      `Requested page (offset ${offset} + limit ${limit} = ${need}) exceeds maxSearchCandidates ` +
        `(${context.maxSearchCandidates}); narrow the page or raise maxSearchCandidates`,
      'maxSearchCandidates',
    );
  }
  let topK = Math.min(need, context.maxSearchCandidates);
  let results: SearchItem[];
  const fetched = new Map<string, Item | null>();
  for (;;) {
    const matches = toRelevanceScores(
      await backend.query(search.namespacePrefix, queryVector, topK),
      context.vectorScoreDirection,
    );
    warnOnNonDescendingScores(context, matches, search.namespacePrefix);
    const scoped = matches.filter((match) =>
      namespaceMatchesPrefix(match.namespace, search.namespacePrefix),
    );
    await fetchUnseen(context, scoped, fetched, signal);
    results = [];
    for (const match of scoped) {
      const item = fetched.get(matchIdentity(match));
      if (item && passesFilter(item, search.filter)) results.push({ ...item, score: match.score });
    }
    if (results.length >= need || matches.length < topK) break;
    if (topK >= context.maxSearchCandidates) {
      // The backend still holds matches, but the filter left the page short at the cap: the same answer the in-DB ranker gives, not a silently short page.
      throw validationError(
        `Semantic search collected ${results.length} of ${need} matches within maxSearchCandidates ` +
          `(${context.maxSearchCandidates}); narrow the filter or raise maxSearchCandidates`,
        'maxSearchCandidates',
      );
    }
    topK = Math.min(topK * 2, context.maxSearchCandidates);
  }
  return results;
}

/**
 * Normalise a backend's matches to the relevance direction upstream
 * `SearchItem.score` documents — "higher scores indicate better matches",
 * typically a cosine similarity between -1 and 1.
 *
 * A distance is converted by **negation** rather than `1 / (1 + d)`: negation
 * is monotone over the whole real line, needs no non-negativity precondition,
 * and is exactly invertible, so the original distance is simply `-score`. A
 * reciprocal would silently imply a different `(0, 1]` scale and is undefined
 * at `d === -1`. Negative scores are already in range for this contract, so
 * nothing is lost by producing them.
 *
 * Results are re-sorted after conversion so a backend that returns its matches
 * in some other order still ranks correctly. Anything that is not `'distance'`
 * is returned untouched — its own order stays authoritative, exactly as before.
 *
 * The test is for `'distance'` rather than against `'relevance'` on purpose:
 * converting is the destructive branch, so only the exact value that asks for
 * it may reach it. Testing the other way round made every unrecognised
 * string — `'Distance'`, a typo, a value read from a config file — reverse the
 * ranking silently, with no error and no warning (the ascending-score warning
 * lives downstream of this conversion, so it could never fire). `setUpStore`
 * rejects such a value outright; this keeps the failure harmless for any
 * caller that reaches the function some other way.
 *
 * Accepts: `matches` — in any order, including empty. `direction` — only the
 * exact string `'distance'` converts; every other value, recognised or not,
 * passes the matches through untouched.
 *
 * Returns: matches whose `score` follows the relevance direction upstream
 * documents, highest first. Converting re-sorts, so a backend that returned its
 * matches in some other order still ranks correctly.
 *
 * Throws: nothing.
 *
 * Guarantees: the conversion is exactly invertible — the original distance is
 * `-score` — so nothing about the backend's answer is lost.
 */
export function toRelevanceScores(
  matches: VectorMatch[],
  direction: VectorScoreDirection,
): VectorMatch[] {
  if (direction !== 'distance') return matches;
  return matches
    .map((match) => ({ ...match, score: -match.score }))
    .sort((left, right) => right.score - left.score);
}
