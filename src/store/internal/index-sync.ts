import type { Logger } from '../../shared/logging/logger';
import type { VectorBackend } from '../vector-backend';

/**
 * Best-effort sync of one item's embedding to the vector backend after the
 * canonical DynamoDB write has already succeeded. A present embedding upserts;
 * its absence deletes any stale vector. Failures are logged at `warn` and
 * swallowed — the canonical item stands and `reconcileVectorIndex` repairs any
 * drift — so a backend hiccup never fails an otherwise-successful put.
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
    logger.warn('store.put vector-index sync failed; reconcileVectorIndex will repair', {
      namespace,
      key,
      message: (error as Error).message,
    });
  }
}
