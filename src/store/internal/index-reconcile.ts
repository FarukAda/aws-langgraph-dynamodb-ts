import { nowSeconds } from '../../shared/clock';
import { mapWithConcurrency } from '../../shared/concurrency';
import { DEFAULT_READ_CONCURRENCY } from '../../shared/constants';
import { isExpiredRow, withoutExpired } from '../../shared/dynamodb/expiry';
import { paginateQuery } from '../../shared/dynamodb/paginate';
import { retryFor } from '../../shared/dynamodb/retry-policy';
import type { StoreItemRecord } from '../types';
import type { VectorBackend, VectorRef } from '../vector-backend';
import type { JsonValue } from './filter';
import { narrowWholeRecord, readStoreItem } from './item-mapper';
import { namespaceMatchesPrefix, partitionKey, sortKey } from './keys';
import { scopedQuery } from './query';
import { embedValues } from './semantic-search';
import type { StoreContext } from './setup';
import { rowIsAbsent } from './write-verify';

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
): Promise<void> {
  if (pending.length === 0) return;
  const batch = pending.splice(0, pending.length);
  const items = await mapWithConcurrency(
    batch,
    context.readConcurrency ?? DEFAULT_READ_CONCURRENCY,
    (record) => readStoreItem(context, record),
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
 * vector. {@link ResultTruncatedError} when `maxScanItems` is reached while rows
 * remain — reconciling from a partial view would prune live vectors.
 *
 * Guarantees: rows are decoded in bounded batches, so a namespace of offloaded
 * items costs neither one round-trip at a time nor every payload in memory at
 * once.
 */
export async function collectReconcileTargets(
  context: StoreContext,
  prefix: string[],
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
    const record = narrowWholeRecord(raw);
    if (!record) {
      context.logger.warn('reconcileVectorIndex: skipped a row that is not a store item', {
        sortKey: raw.SK as string,
      });
      continue;
    }
    if (isExpiredRow(record, now) || !namespaceMatchesPrefix(record.namespace, prefix)) continue;
    pending.push(record);
    if (pending.length >= batchLimit) await drainPending(context, pending, live);
  }
  await drainPending(context, pending, live);
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
  return rowIsAbsent(context, {
    PK: partitionKey(ref.namespace),
    SK: sortKey(ref.namespace, ref.key),
  });
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
  prefix: string[],
  live: ReconcileTarget[],
): Promise<number> {
  if (!backend.listKeys) {
    context.logger.info('reconcileVectorIndex prune skipped: backend has no listKeys', { prefix });
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
    if (
      !observed.has(refIdentity(ref.namespace, ref.key)) &&
      !(await confirmedGone(context, ref))
    ) {
      context.logger.info('reconcileVectorIndex: kept a vector whose item reappeared', {
        namespace: ref.namespace,
        key: ref.key,
      });
      continue;
    }
    await backend.delete(ref.namespace, ref.key);
    pruned += 1;
  }
  return pruned;
}
