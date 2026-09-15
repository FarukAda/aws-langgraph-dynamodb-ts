import type { Logger } from '../../shared/logging/logger';
import type { VectorBackend } from '../vector-backend';

/**
 * Best-effort sync of one item's embedding to the vector backend after the
 * canonical DynamoDB write has already succeeded.
 *
 * Accepts: `embedding` — present upserts it; absent deletes any vector the
 * backend still holds, which is what a re-put with no indexable text, an
 * `index: false` put and a delete all mean.
 *
 * Returns: nothing, in both the synced and the failed case.
 *
 * Throws: nothing. The canonical item is already committed, so failing here
 * would report a put that in fact succeeded; the drift is logged at `warn` and
 * `reconcileVectorIndex` repairs it.
 */
export async function syncVectorIndex(
  backend: VectorBackend,
  namespace: string[],
  key: string,
  embedding: number[] | undefined,
  logger: Logger,
): Promise<void> {
  try {
    if (embedding) await backend.upsert(namespace, key, embedding);
    else await backend.delete(namespace, key);
  } catch (error) {
    /** The name, not the message: a backend's error text is not an identifier. */
    logger.warn('store.put vector-index sync failed; reconcileVectorIndex will repair', {
      namespace,
      key,
      reason: (error as Error).name,
    });
  }
}
