/**
 * Item builder utilities for per-message chat history storage
 * Builds DynamoDB items for metadata and individual messages
 */

import type { BaseMessage } from '@langchain/core/messages';
import { mapChatMessagesToStoredMessages } from '@langchain/core/messages';

import { calculateTTLTimestamp } from '../../shared';
import type { DynamoDBMessageItem } from '../types';

/**
 * Format a message index as a zero-padded 6-digit string.
 *
 * @remarks
 * The 6-digit width caps a session at **999 999 messages** while preserving
 * lexicographic sort order on the composite SK. Beyond that, index 1 000 000
 * would sort *before* 999 999 as a string, corrupting replay order. If you
 * expect sessions to approach this bound, either shard by sub-session or widen
 * the padding here (and migrate existing data).
 */
export function formatMessageIndex(index: number): string {
  return String(index).padStart(6, '0');
}

/**
 * Build the sort key for a message item
 *
 * @param sessionId - Session identifier
 * @param messageIndex - Zero-based message index
 * @returns Composite SK like "sessionId#msg#000001"
 */
export function buildMessageSK(sessionId: string, messageIndex: number): string {
  return `${sessionId}#msg#${formatMessageIndex(messageIndex)}`;
}

/**
 * Build DynamoDB message items from BaseMessage array
 *
 * @param userId - User identifier
 * @param sessionId - Session identifier
 * @param messages - Messages to serialize
 * @param startIndex - Starting message index (for appending to existing session)
 * @param ttlDays - Optional TTL in days
 * @returns Array of DynamoDB message items
 */
export function buildMessageItems(
  userId: string,
  sessionId: string,
  messages: BaseMessage[],
  startIndex: number,
  ttlDays?: number,
): DynamoDBMessageItem[] {
  const storedMessages = mapChatMessagesToStoredMessages(messages);
  const ttl = ttlDays !== undefined ? calculateTTLTimestamp(ttlDays) : undefined;

  return storedMessages.map((storedMessage, i) => {
    const messageIndex = startIndex + i;
    const item: DynamoDBMessageItem = {
      userId,
      sessionId: buildMessageSK(sessionId, messageIndex),
      itemType: 'message',
      messageIndex,
      message: storedMessage,
    };
    if (ttl !== undefined) {
      item.ttl = ttl;
    }
    return item;
  });
}

/**
 * Build an optimistic-lock metadata update expression.
 *
 * Writes a new messageCount conditional on the caller's observed previous value
 * (or on the metadata item not existing yet). The caller handles the
 * ConditionalCheckFailed case by re-reading and retrying, which prevents the
 * counter from getting ahead of the actual messages on transient put failures.
 *
 * @param title - Session title (only set on first write via if_not_exists)
 * @param newCount - Target total messageCount after this write
 * @param expectedCount - Previously observed messageCount (undefined for new session)
 * @param ttlDays - Optional TTL in days
 */
export function buildOptimisticMetadataUpdate(
  title: string,
  newCount: number,
  expectedCount: number | undefined,
  ttlDays?: number,
): {
  updateExpression: string;
  conditionExpression: string;
  expressionAttributeValues: Record<string, any>;
} {
  const now = Date.now();
  const setParts = [
    'updatedAt = :updatedAt',
    'itemType = :itemType',
    'messageCount = :newCount',
    'title = if_not_exists(title, :title)',
    'createdAt = if_not_exists(createdAt, :createdAt)',
  ];
  const expressionAttributeValues: Record<string, any> = {
    ':updatedAt': now,
    ':createdAt': now,
    ':newCount': newCount,
    ':itemType': 'metadata',
    ':title': title,
  };

  let conditionExpression: string;
  if (expectedCount === undefined) {
    // New session: metadata item must not exist yet.
    conditionExpression = 'attribute_not_exists(messageCount)';
  } else {
    conditionExpression = 'messageCount = :expectedCount';
    expressionAttributeValues[':expectedCount'] = expectedCount;
  }

  if (ttlDays !== undefined) {
    setParts.push('ttl = :ttl');
    expressionAttributeValues[':ttl'] = calculateTTLTimestamp(ttlDays);
  }

  return {
    updateExpression: `SET ${setParts.join(', ')}`,
    conditionExpression,
    expressionAttributeValues,
  };
}
