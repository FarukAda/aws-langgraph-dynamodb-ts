import { paginateQuery } from '../../shared/dynamodb/paginate';
import type { VectorBackend, VectorRef } from '../vector-backend';
import type { JsonValue } from './filter';
import { narrowStoreRecord, readStoreItem } from './item-mapper';
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
interface LiveItem {
  namespace: string[];
  key: string;
  value: Record<string, JsonValue>;
}

/** Stable, collision-free identity for a (namespace, key) pair. */
function refIdentity(namespace: string[], key: string): string {
  return JSON.stringify([...namespace, key]);
}

/**
 * Enumerate canonical items under `prefix`, then recompute their embeddings in
 * batches (one `embedDocuments` call per 100 items rather than one per item).
 * A failed embedding rejects the whole reconcile by design: silently skipping
 * an item would drop it from the live set, after which {@link selectOrphans}
 * would prune its still-valid backend vector. Fail-fast keeps the backend from
 * losing data.
 */
export async function collectReconcileTargets(
  context: StoreContext,
  prefix: string[],
): Promise<ReconcileTarget[]> {
  const live: LiveItem[] = [];
  const source = paginateQuery({
    retry: context.retry,
    client: context.client,
    params: scopedQuery(context.tableName, prefix),
    maxItems: context.maxScanItems,
  });
  for await (const raw of source) {
    const record = narrowStoreRecord(raw);
    if (!record) {
      context.logger.warn('reconcileVectorIndex: skipped a row that is not a store item', {
        sortKey: raw.SK as string,
      });
      continue;
    }
    if (!namespaceMatchesPrefix(record.namespace, prefix)) continue;
    const item = await readStoreItem(context, record);
    live.push({
      namespace: record.namespace,
      key: record.key,
      value: item.value as Record<string, JsonValue>,
    });
  }
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

/** Re-push every live embedding to the backend; returns the upsert count. */
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

/** Refs present in the backend but absent from `live` — orphans to prune. */
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

/** Delete backend vectors with no canonical item; returns the prune count. */
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
