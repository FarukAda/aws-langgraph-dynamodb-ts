import { paginateQuery } from '../../shared/dynamodb/paginate';
import type { StoreItemRecord } from '../types';
import type { VectorBackend, VectorRef } from '../vector-backend';
import type { JsonValue } from './filter';
import { readStoreItem } from './item-mapper';
import { namespaceMatchesPrefix } from './keys';
import { scopedQuery } from './query';
import { embedValue } from './semantic-search';
import type { StoreContext } from './setup';

/** A canonical item's location plus the embedding recomputed for it. */
export interface ReconcileTarget {
  namespace: string[];
  key: string;
  embedding: number[] | undefined;
}

/** Stable, collision-free identity for a (namespace, key) pair. */
function refIdentity(namespace: string[], key: string): string {
  return JSON.stringify([...namespace, key]);
}

/**
 * Enumerate canonical items under `prefix`, recomputing each embedding. A failed
 * embedding rejects the whole reconcile by design: silently skipping an item
 * would drop it from the live set, after which {@link selectOrphans} would prune
 * its still-valid backend vector. Fail-fast keeps the backend from losing data.
 */
export async function collectReconcileTargets(
  context: StoreContext,
  prefix: string[],
): Promise<ReconcileTarget[]> {
  const targets: ReconcileTarget[] = [];
  const source = paginateQuery({
    client: context.client,
    params: scopedQuery(context.tableName, prefix),
  });
  for await (const raw of source) {
    const record = raw as StoreItemRecord;
    if (!record.namespace || !namespaceMatchesPrefix(record.namespace, prefix)) continue;
    const item = await readStoreItem(context, record);
    const embedding = await embedValue(context, item.value as Record<string, JsonValue>);
    targets.push({ namespace: record.namespace, key: record.key, embedding });
  }
  return targets;
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
  const orphans = selectOrphans(await backend.listKeys(prefix), live);
  for (const ref of orphans) {
    await backend.delete(ref.namespace, ref.key);
  }
  return orphans.length;
}
