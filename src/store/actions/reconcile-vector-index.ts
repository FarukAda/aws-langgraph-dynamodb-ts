import { validationError } from '../../shared/errors/errors';
import { collectReconcileTargets, pruneOrphans, pushEmbeddings } from '../internal/index-reconcile';
import type { StoreContext } from '../internal/setup';
import { validateNamespace } from '../internal/validation';

/** Counts returned by {@link reconcileVectorIndex}. */
export interface VectorReconcileResult {
  upserted: number;
  pruned: number;
}

/**
 * Repair the vector backend against the canonical DynamoDB items under
 * `namespacePrefix`: re-push every live embedding, and — when the backend
 * implements {@link VectorBackend.listKeys} — prune vectors with no canonical
 * item. A maintenance tool for backend drift; run it when the namespace is
 * idle.
 *
 * Accepts: `namespacePrefix` — a non-empty namespace, since the repair is
 * scoped to one partition's items. `options.signal` — aborts between pages.
 *
 * Returns: how many vectors were upserted and how many pruned.
 *
 * Throws: ValidationError naming `namespacePrefix` or `namespacePrefix element`
 * for an empty or malformed prefix, as `search` names it, and `vectorBackend`
 * when the store has no index or backend to reconcile;
 * {@link ResultTruncatedError} past `maxScanItems`, since repairing from a
 * partial view would prune live vectors; whatever the reads, the embeddings
 * model and the backend throw.
 *
 * Guarantees: re-embeds with the store's configured fields, so a per-put
 * `index` field override is not reproduced — a reconcile makes the backend
 * agree with the store's configuration, not with each item's write-time one.
 * DynamoDB is never written: only the backend is repaired.
 */
export async function reconcileVectorIndex(
  context: StoreContext,
  namespacePrefix: string[],
  options: { signal?: AbortSignal } = {},
): Promise<VectorReconcileResult> {
  validateNamespace(namespacePrefix, 'namespacePrefix');
  if (!context.index || !context.vectorBackend) {
    throw validationError(
      'reconcileVectorIndex requires a configured index and vectorBackend',
      'vectorBackend',
    );
  }
  const backend = context.vectorBackend;
  const targets = await collectReconcileTargets(context, namespacePrefix, options.signal);
  const upserted = await pushEmbeddings(backend, targets);
  const pruned = await pruneOrphans(context, backend, namespacePrefix, targets);
  return { upserted, pruned };
}
