import type { putWithRevisionSwap } from '../../../src/store/internal/item-write';
import type { ExistingRowMeta } from '../../../src/store/internal/rows';

/**
 * What a revision swap the test expects to commit superseded. A swap settling
 * on a failure rejects with that failure instead, so the test fails at the call
 * rather than on a later assertion about what was superseded.
 */
export async function landed(
  swap: ReturnType<typeof putWithRevisionSwap>,
): Promise<ExistingRowMeta> {
  const outcome = await swap;
  if (!outcome.ok) throw outcome.reason;
  return outcome.superseded;
}
