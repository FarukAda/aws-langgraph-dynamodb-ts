import { type PayloadDescriptor, PayloadLocation } from '../../shared/codec/codec';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import type { StoreContext } from './setup';

/** True when `error` is a {@link RetryExhaustedError} — by name, not `instanceof` (banned repo-wide). */
export function isRetryExhausted(error: Error): boolean {
  return error.name === 'RetryExhaustedError';
}

/**
 * True when the row is confirmed absent — used to resolve an ambiguous
 * retry-exhausted *delete*, where the delete may well have landed server-side
 * and only its acknowledgement was lost. A failure reading this is not treated
 * as confirmation, which is fail-safe here: the caller only rethrows, and
 * nothing is deleted on the strength of a `false`.
 */
export async function rowIsAbsent(
  context: StoreContext,
  key: { PK: string; SK: string },
): Promise<boolean> {
  try {
    const result = await withDynamoDBRetry(
      () =>
        context.client.get({
          TableName: context.tableName,
          Key: key,
          ConsistentRead: true,
          ProjectionExpression: '#v',
          ExpressionAttributeNames: { '#v': 'value' },
        }),
      context.retry,
    );
    return result.Item === undefined;
  } catch {
    return false;
  }
}

/** What a post-failure verification read could establish about a write. */
export type WriteVerdict = 'landed' | 'not-landed' | 'unverified';

/**
 * Read `record`'s row back to establish what an ambiguous write actually did.
 *
 * - `'landed'`: the row holds `expectedS3Key`, so the write committed
 *   server-side and only its acknowledgement was lost.
 * - `'not-landed'`: the row was read and holds something else, or nothing, so
 *   this call's own nonced upload is dead and safe to delete.
 * - `'unverified'`: the read itself failed, so nothing is established.
 *
 * The third answer used to be folded into the second as a plain `false`, which
 * made a partition that blocked both the put and this read delete the object a
 * possibly-live row points at — permanently breaking every later read of that
 * item. Only a *confirmed* non-commit may delete the new upload: leaking one
 * object (reclaimed by `ensureS3LifecycleRule`) is recoverable, stranding a
 * live row is not.
 */
export async function verifyWriteLanded(
  context: StoreContext,
  record: { PK: string; SK: string },
  expectedS3Key: string,
): Promise<WriteVerdict> {
  try {
    const result = await withDynamoDBRetry(
      () =>
        context.client.get({
          TableName: context.tableName,
          Key: { PK: record.PK, SK: record.SK },
          ConsistentRead: true,
          ProjectionExpression: '#v',
          ExpressionAttributeNames: { '#v': 'value' },
        }),
      context.retry,
    );
    const value = result.Item?.value as PayloadDescriptor | undefined;
    return value?.location === PayloadLocation.S3 && value.s3Key === expectedS3Key
      ? 'landed'
      : 'not-landed';
  } catch {
    return 'unverified';
  }
}
