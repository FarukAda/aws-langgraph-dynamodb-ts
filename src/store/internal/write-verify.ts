import { REVISION_ATTRIBUTE } from '../../shared/dynamodb/conditional-put';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import type { StoreContext } from './setup';

/** True when `error` is a {@link RetryExhaustedError} — by name, not `instanceof` (banned repo-wide). */
export function isRetryExhausted(error: Error): boolean {
  return error.name === 'RetryExhaustedError';
}

/**
 * True when the row is confirmed absent — used to resolve an ambiguous
 * retry-exhausted *delete*, where the delete may well have landed server-side
 * and only its acknowledgement was lost. Only the partition key is projected:
 * existence is the whole question. A failure reading this is not treated as
 * confirmation, which is fail-safe here: the caller only rethrows, and nothing
 * is deleted on the strength of a `false`.
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
          ProjectionExpression: '#pk',
          ExpressionAttributeNames: { '#pk': 'PK' },
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
 * Read `record`'s row back to establish what an ambiguous write actually did,
 * comparing the row's revision with the one this write carried. Every put
 * stamps a fresh per-call `rev`, so the comparison works for inline and
 * offloaded records alike.
 *
 * - `'landed'`: the row holds this write's `rev`, so it committed server-side
 *   and only its acknowledgement was lost.
 * - `'not-landed'`: the row was read and holds something else, or nothing —
 *   or the record carries no `rev` to compare — so this call's own upload, if
 *   any, is dead and safe to delete.
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
  record: { PK: string; SK: string; rev?: string },
): Promise<WriteVerdict> {
  if (record.rev === undefined) return 'not-landed';
  try {
    const result = await withDynamoDBRetry(
      () =>
        context.client.get({
          TableName: context.tableName,
          Key: { PK: record.PK, SK: record.SK },
          ConsistentRead: true,
          ProjectionExpression: '#r',
          ExpressionAttributeNames: { '#r': REVISION_ATTRIBUTE },
        }),
      context.retry,
    );
    return result.Item?.[REVISION_ATTRIBUTE] === record.rev ? 'landed' : 'not-landed';
  } catch {
    return 'unverified';
  }
}
