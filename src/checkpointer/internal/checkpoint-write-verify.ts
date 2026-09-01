import { type PayloadDescriptor, PayloadLocation } from '../../shared/codec/codec';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import type { CheckpointMetaItem, CheckpointPayloadItem } from '../types';
import type { CheckpointerContext } from './setup';

/** What a post-failure verification read could establish about a put. */
export type CheckpointWriteVerdict = 'landed' | 'not-landed' | 'unverified';

/** The S3 key an offloaded descriptor points at, or undefined for inline/absent. */
function offloadedKey(descriptor: PayloadDescriptor | undefined): string | undefined {
  return descriptor?.location === PayloadLocation.S3 ? descriptor.s3Key : undefined;
}

/** Which row to read back, and the key it must hold for the write to count as landed. */
interface Probe {
  key: { PK: string; SK: string };
  attribute: 'metadata' | 'checkpoint';
  expected: string;
}

/**
 * Pick the row carrying an offloaded descriptor. The META and PAYLOAD rows
 * commit in one transaction, so one of them is enough; with neither offloaded
 * there is nothing to protect and no read to spend.
 */
function chooseProbe(meta: CheckpointMetaItem, payload: CheckpointPayloadItem): Probe | undefined {
  const metaKey = offloadedKey(meta.metadata);
  if (metaKey !== undefined) {
    return { key: { PK: meta.PK, SK: meta.SK }, attribute: 'metadata', expected: metaKey };
  }
  const payloadKey = offloadedKey(payload.checkpoint);
  if (payloadKey !== undefined) {
    return {
      key: { PK: payload.PK, SK: payload.SK },
      attribute: 'checkpoint',
      expected: payloadKey,
    };
  }
  return undefined;
}

/**
 * Read one of the two rows back after the META+PAYLOAD transaction failed and
 * report what that failure actually did — never assuming it did nothing.
 *
 * No rejection is proof of a non-commit: `withDynamoDBRetry` re-issues a
 * transaction whose response was lost, and the re-issues can time out at the
 * transport without reaching DynamoDB, so the budget is spent on a
 * `RetryExhaustedError` while the rows are committed. Deleting the uploads on
 * that basis stranded the head checkpoint of a thread on a `NoSuchKey`.
 *
 * Keys are nonced per call (see `buildCheckpointItems`), so "the row holds
 * this attempt's key" is the same statement as "this attempt's write is
 * live". When neither descriptor is offloaded there is nothing to delete, so
 * the answer is simply "safe to clean up", a no-op for the caller.
 *
 * A read failure establishes nothing; the caller then leaks one object at
 * worst (reclaimed by `ensureS3LifecycleRule`) rather than deleting one a live
 * row may point at — the same trade `store/internal/persist.ts` makes.
 */
export async function verifyCheckpointLanded(
  context: CheckpointerContext,
  meta: CheckpointMetaItem,
  payload: CheckpointPayloadItem,
): Promise<CheckpointWriteVerdict> {
  const probe = chooseProbe(meta, payload);
  if (!probe) return 'not-landed';
  try {
    const result = await withDynamoDBRetry(() =>
      context.client.get({
        TableName: context.tableName,
        Key: probe.key,
        ConsistentRead: true,
        ProjectionExpression: '#d',
        ExpressionAttributeNames: { '#d': probe.attribute },
      }),
    );
    const stored = result.Item?.[probe.attribute] as PayloadDescriptor | undefined;
    return offloadedKey(stored) === probe.expected ? 'landed' : 'not-landed';
  } catch {
    return 'unverified';
  }
}
