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
}

/**
 * Build the metadata `Update` transact-item: `ADD` the message count and `SET`
 * `updatedAt` every time, while `createdAt`, `sessionId`, and `title` are written
 * once via `if_not_exists`. The `ttl` anchor is owned by the conditional anchor
 * write, never here, so it is not touched.
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
  return {
    Update: {
      TableName: tableName,
      Key: { PK: sessionPartition(fields.sessionId), SK: SESSION_SORT_KEY },
      UpdateExpression: `ADD #count :n SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  };
}
