import { ValidationError } from '../../shared/errors/errors';
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
 * idle. Re-embeds with the store's configured fields, so per-put `index` field
 * overrides are not reproduced. Requires a configured `index` and
 * `vectorBackend`; the prefix must be a non-empty namespace.
 */
export async function reconcileVectorIndex(
  context: StoreContext,
  namespacePrefix: string[],
  options: { signal?: AbortSignal } = {},
): Promise<VectorReconcileResult> {
  validateNamespace(namespacePrefix);
  if (!context.index || !context.vectorBackend) {
    throw new ValidationError('reconcileVectorIndex requires a configured index and vectorBackend');
  }
  const backend = context.vectorBackend;
  const targets = await collectReconcileTargets(context, namespacePrefix, options.signal);
  const upserted = await pushEmbeddings(backend, targets);
  const pruned = await pruneOrphans(context, backend, namespacePrefix, targets);
  return { upserted, pruned };
}
