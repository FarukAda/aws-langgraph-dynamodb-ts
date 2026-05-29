import { type BaseMessage, mapChatMessagesToStoredMessages } from '@langchain/core/messages';

import { nowIso } from '../../shared/clock';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { validateNonEmptyString } from '../../shared/validation/primitives';
import { calculateTtlTimestamp } from '../../shared/validation/ttl';
import { buildSessionItem, decodeMessages, readRawSession } from '../internal/item-mapper';
import { withOptimisticRetry } from '../internal/optimistic-retry';
import type { HistoryContext } from '../internal/setup';
import { deriveTitle } from '../internal/title-generator';
import type { ChatSessionItem } from '../types';

function condition(existing: ChatSessionItem | undefined) {
  if (!existing) return { ConditionExpression: 'attribute_not_exists(PK)' };
  return {
    ConditionExpression: '#v = :v',
    ExpressionAttributeNames: { '#v': 'version' },
    ExpressionAttributeValues: { ':v': existing.version },
  };
}

/**
 * Append messages to a session via an optimistic read-modify-write: read the
 * current list + version, append, and conditionally write the next version,
 * retrying if a concurrent writer won the race. The whole session shares one
 * TTL, so a live session never develops mid-history gaps.
 */
export async function addMessages(
  context: HistoryContext,
  sessionId: string,
  messages: BaseMessage[],
): Promise<void> {
  validateNonEmptyString(sessionId, 'sessionId');
  if (messages.length === 0) return;
  const incoming = mapChatMessagesToStoredMessages(messages);
  await withOptimisticRetry(async () => {
    const existing = await readRawSession(context, sessionId);
    const prior = existing ? await decodeMessages(context, existing) : [];
    const merged = [...prior, ...incoming];
    const timestamp = nowIso();
    const item = await buildSessionItem(context, sessionId, merged, {
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      title: existing?.title ?? deriveTitle(merged),
      ttlTimestamp: context.ttl ? calculateTtlTimestamp(context.ttl) : undefined,
    });
    await withDynamoDBRetry(() =>
      context.client.put({ TableName: context.tableName, Item: item, ...condition(existing) }),
    );
  });
}
