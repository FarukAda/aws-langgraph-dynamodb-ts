import type { NativeAttributeValue, TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';

import { DEFAULT_INDEX_SHARDS, indexKeys } from '../../shared/dynamodb/index-keys';
import { ROW_FORMAT_VERSION } from '../../shared/dynamodb/row-version';
import { SESSION_SORT_KEY, sessionPartition } from './keys';

/** One member of a {@link TransactWriteCommandInput} `TransactItems` list. */
export type HistoryTransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

/** Fields driving the per-session metadata update inside the append transaction. */
export interface SessionUpdateFields {
  sessionId: string;
  /** Index partitions, from the adapter's context; see `indexKeys`. */
  indexShards?: number;
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
 *
 * Accepts: `count` — how many messages this append adds, which `ADD` applies to
 * whatever the row holds, so two concurrent appends both count. `title` —
 * written once and never overwritten, so a session keeps the title its first
 * turn produced. `ttlTimestamp` — absent leaves the row without an expiry.
 * `forceTtlRefresh` — see above.
 *
 * Returns: the `Update` transact-item. It creates the row when there is none:
 * every once-only field is an `if_not_exists`, so the first append and the
 * thousandth build the same item.
 *
 * Throws: nothing. The condition it carries is evaluated by DynamoDB, and a
 * failed condition surfaces from the transaction, not from here.
 */
export function buildSessionUpdateItem(
  tableName: string,
  fields: SessionUpdateFields,
): HistoryTransactItem {
  const index = indexKeys(
    'SESS',
    fields.sessionId,
    fields.now,
    fields.indexShards ?? DEFAULT_INDEX_SHARDS,
  );
  const names: Record<string, string> = {
    '#count': 'messageCount',
    '#u': 'updatedAt',
    '#c': 'createdAt',
    '#sid': 'sessionId',
    '#v': 'v',
    '#gpk': 'gsi1pk',
    '#gsk': 'gsi1sk',
  };
  const values: Record<string, NativeAttributeValue> = {
    ':n': fields.count,
    ':u': fields.now,
    ':c': fields.now,
    ':sid': fields.sessionId,
    ':v': ROW_FORMAT_VERSION,
    ':gpk': index.gsi1pk,
    ':gsk': index.gsi1sk,
  };
  /**
   * The row's format version is rewritten on every update, not only on
   * creation: an append by this version leaves a row this version wrote, and a
   * reader must be told that rather than infer it from which attributes happen
   * to be present.
   */
  const sets = [
    '#u = :u',
    '#c = if_not_exists(#c, :c)',
    '#sid = if_not_exists(#sid, :sid)',
    '#v = :v',
    /**
     * The session row is listed by recency across partitions, so it carries the
     * index keys — rewritten on every append, which is what keeps "most
     * recently updated first" true without an in-memory sort.
     */
    '#gpk = :gpk',
    '#gsk = :gsk',
  ];
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
