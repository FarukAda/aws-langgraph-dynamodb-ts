import {
  isConditionalCheckFailed,
  OVERWRITE_CAS_MAX_ATTEMPTS,
  REVISION_ATTRIBUTE,
  revisionGuard,
} from '../../shared/dynamodb/conditional-put';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import type { StoreItemRecord } from '../types';
import { type ExistingRecordMeta, readExisting } from './read-existing';
import type { StoreContext } from './setup';

/** Put the record, optionally pinned to the revision the caller observed. */
async function put(
  context: StoreContext,
  record: StoreItemRecord,
  observed?: ExistingRecordMeta,
): Promise<void> {
  const guard = observed ? revisionGuard(REVISION_ATTRIBUTE, observed) : {};
  await withDynamoDBRetry(
    () => context.client.put({ TableName: context.tableName, Item: record, ...guard }),
    context.retry,
  );
}

/**
 * Commit `record`, re-reading and retrying while another writer holds the row,
 * and return the state this write actually superseded — the only descriptor
 * safe to delete afterwards.
 *
 * Without the swap both racers read the same previous descriptor, both commit,
 * and both delete it, orphaning the loser's own upload. Retrying against the
 * *re-read* state is what makes each writer supersede exactly one payload.
 *
 * A rejection is not proof a competitor won: `withDynamoDBRetry` retries
 * transient errors, so an attempt can commit server-side, its response can be
 * lost, and the retried put can hit the row it just wrote and fail the same
 * guard — indistinguishable from a competitor's win by the rejection alone.
 * Each attempt's pinned observation is captured in `attempted` before the
 * put, so that when a re-read finds the row already holding *this call's
 * own* `rev`, the swap returns whatever `attempted` held — never this
 * record's own just-committed value, which would strand the live row
 * pointing at a deleted object. That comparison is guarded on `rev` being
 * set: `rev` is optional on the record type, and an unnonced record against a
 * pre-0.9.0 revision-less row would otherwise match `undefined === undefined`
 * and claim a race it never entered.
 *
 * On exhaustion the write proceeds unconditionally and warns. That is
 * deliberate: the fallback is precisely the pre-0.9.0 behaviour — one possible
 * orphan, reclaimed by a lifecycle rule — so pathological contention degrades
 * instead of turning a working put into an error. `createdAt` is refreshed from
 * each re-read so a row created by whoever won keeps its true creation time.
 */
export async function putWithRevisionSwap(
  context: StoreContext,
  record: StoreItemRecord,
  existing: ExistingRecordMeta,
): Promise<ExistingRecordMeta> {
  let observed = existing;
  for (let attempt = 1; attempt <= OVERWRITE_CAS_MAX_ATTEMPTS; attempt++) {
    const attempted = observed;
    try {
      await put(context, record, attempted);
      return attempted;
    } catch (error) {
      if (!isConditionalCheckFailed(error as { name?: string })) throw error;
      observed = await readExisting(context, record.PK, record.SK);
      if (record.rev !== undefined && observed.revision === record.rev) return attempted;
      record.createdAt = observed.createdAt ?? record.createdAt;
    }
  }
  context.logger.warn(
    'store.put: compare-and-swap exhausted; overwriting unconditionally, which can orphan one ' +
      'S3 object under a concurrent put (reclaimed by ensureS3LifecycleRule)',
    { namespace: record.namespace, key: record.key, attempts: OVERWRITE_CAS_MAX_ATTEMPTS },
  );
  await put(context, record);
  return observed;
}
