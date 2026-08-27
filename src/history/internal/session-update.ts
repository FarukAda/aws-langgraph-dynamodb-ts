import type { NativeAttributeValue, TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';

import { SESSION_SORT_KEY, sessionPartition } from './keys';

/** One member of a {@link TransactWriteCommandInput} `TransactItems` list. */
export type HistoryTransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

/** Fields driving the per-session metadata update inside the append transaction. */
export interface SessionUpdateFields {
  sessionId: string;
  count: number;
  now: string;
  title?: string;
  ttlTimestamp?: number;
  forceTtlRefresh?: boolean;
}

/**
 * Build the metadata `Update` transact-item: `ADD` the message count and `SET`
 * `updatedAt` every time, while `createdAt`, `sessionId`, `title`, and the `ttl`
 * anchor are written once via `if_not_exists`. Folding the `ttl` anchor in here
 * means the first append fixes one shared expiry atomically with the count, with
 * no separate pre-write that could orphan a metadata-only row. When
 * `forceTtlRefresh` is set (because {@link resolveTtlAnchor} found the persisted
 * anchor missing or already expired), the `ttl` clause instead does a plain
 * `SET`, so the SESSION row's own stale attribute actually heals instead of
 * being permanently blocked by `if_not_exists`. When forceTtlRefresh is set,
 * the SET is additionally guarded by a ConditionExpression so a concurrent
 * caller's already-healed anchor can never be regressed backward — see
 * message-transaction.ts for how a lost race is retried without forcing.
 */
export function buildSessionUpdateItem(
  tableName: string,
  fields: SessionUpdateFields,
): HistoryTransactItem {
  const names: Record<string, string> = {
    '#count': 'messageCount',
    '#u': 'updatedAt',
    '#c': 'createdAt',
    '#sid': 'sessionId',
  };
  const values: Record<string, NativeAttributeValue> = {
    ':n': fields.count,
    ':u': fields.now,
    ':c': fields.now,
    ':sid': fields.sessionId,
  };
  const sets = ['#u = :u', '#c = if_not_exists(#c, :c)', '#sid = if_not_exists(#sid, :sid)'];
  if (fields.title !== undefined) {
    names['#title'] = 'title';
    values[':title'] = fields.title;
    sets.push('#title = if_not_exists(#title, :title)');
  }
  let conditionExpression: string | undefined;
  if (fields.ttlTimestamp !== undefined) {
    names['#ttl'] = 'ttl';
    values[':ttl'] = fields.ttlTimestamp;
    if (fields.forceTtlRefresh) {
      sets.push('#ttl = :ttl');
      /**
       * Guards the force-overwrite so a concurrent caller's already-healed,
       * equal-or-later anchor can never be regressed backward by this one.
       * `<=` (not `<`): two concurrent healers of the same stale anchor
       * typically compute the identical target timestamp, and `<=` lets
       * the second one succeed by re-applying the same value instead of
       * failing the condition and paying a full transaction retry for a
       * write that was never actually a regression.
       */
      conditionExpression = 'attribute_not_exists(#ttl) OR #ttl <= :ttl';
    } else {
      sets.push('#ttl = if_not_exists(#ttl, :ttl)');
    }
  }
  return {
    Update: {
      TableName: tableName,
      Key: { PK: sessionPartition(fields.sessionId), SK: SESSION_SORT_KEY },
      UpdateExpression: `ADD #count :n SET ${sets.join(', ')}`,
      ...(conditionExpression ? { ConditionExpression: conditionExpression } : {}),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  };
}
