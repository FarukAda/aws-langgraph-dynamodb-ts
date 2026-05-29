import { MAX_UNPROCESSED_RETRIES } from '../../shared/constants';
import { ConflictError } from '../../shared/errors/errors';

/** True when an error is a DynamoDB optimistic-concurrency condition failure. */
export function isConditionalCheckFailed(error: Error): boolean {
  return (error as { name?: string }).name === 'ConditionalCheckFailedException';
}

/**
 * Run a read-modify-write `attempt`, retrying when its conditional write loses
 * an optimistic-concurrency race. Other errors propagate; exhausting the budget
 * throws {@link ConflictError}.
 */
export async function withOptimisticRetry(
  attempt: () => Promise<void>,
  maxAttempts: number = MAX_UNPROCESSED_RETRIES,
): Promise<void> {
  for (let tries = 1; tries <= maxAttempts; tries++) {
    try {
      await attempt();
      return;
    } catch (error) {
      if (!isConditionalCheckFailed(error as Error)) throw error;
      if (tries === maxAttempts) {
        throw new ConflictError(
          `Concurrent update conflict persisted after ${maxAttempts} attempts`,
          error as Error,
        );
      }
    }
  }
}
