import type { NativeAttributeValue, UpdateCommandInput } from '@aws-sdk/lib-dynamodb';

import { SESSION_SORT_KEY, sessionPartition } from './keys';

/** Fields driving the atomic per-session metadata update. */
export interface SessionUpdateFields {
  sessionId: string;
  count: number;
  now: string;
  title?: string;
  ttlTimestamp?: number;
}

/**
 * Build the atomic session-metadata update: `ADD` the message count and `SET`
 * `updatedAt` every time, while `createdAt`, `sessionId`, `title`, and the
 * creation-anchored `ttl` are written once via `if_not_exists`. Returns
 * `ALL_NEW` so the caller reads back the authoritative TTL anchor that every
 * message item in the session shares.
 */
export function buildSessionUpdate(
  tableName: string,
  fields: SessionUpdateFields,
): UpdateCommandInput {
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
  if (fields.ttlTimestamp !== undefined) {
    names['#ttl'] = 'ttl';
    values[':ttl'] = fields.ttlTimestamp;
    sets.push('#ttl = if_not_exists(#ttl, :ttl)');
  }
  return {
    TableName: tableName,
    Key: { PK: sessionPartition(fields.sessionId), SK: SESSION_SORT_KEY },
    UpdateExpression: `ADD #count :n SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW',
  };
}
