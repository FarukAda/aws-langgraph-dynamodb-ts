/**
 * Hides what a reconcile refuses before it touches the backend.
 *
 * A repair is scoped to one partition's items, so its prefix must be a
 * non-empty namespace, and without an `index` and a `vectorBackend` there is
 * nothing to repair; both are refused here, before any read. How the backend
 * is then made to agree with the table belongs to the vector index, so the
 * store's method knows neither half.
 */

import { validationError } from '../../shared/errors/errors';
import { parseNamespace } from '../internal/parse';
import type { StoreContext } from '../internal/setup';
import { hasVectorBackend, reconcileVectors } from '../internal/vector-index';
import type { VectorReconcileResult } from '../types';

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
 * Throws: `VALIDATION` naming `namespacePrefix` or `namespacePrefix element`
 * for an empty or malformed prefix, as `search` names it, and `vectorBackend`
 * when the store has no index or backend to reconcile;
 * `RESULT_TRUNCATED` past `maxScanItems` or `maxIterations`, since repairing
 * from a partial view would prune live vectors; whatever the reads, the
 * embeddings model and the backend throw.
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
  const prefix = parseNamespace(namespacePrefix, 'namespacePrefix');
  if (!hasVectorBackend(context)) {
    throw validationError(
      'reconcileVectorIndex requires a configured index and vectorBackend',
      'vectorBackend',
    );
  }
  return reconcileVectors(context, prefix, options.signal);
}
