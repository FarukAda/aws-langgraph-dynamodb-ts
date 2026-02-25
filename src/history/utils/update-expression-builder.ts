/**
 * Item builder utilities for per-message chat history storage
 * Builds DynamoDB items for metadata and individual messages
 */

import type { BaseMessage } from '@langchain/core/messages';
import { mapChatMessagesToStoredMessages } from '@langchain/core/messages';

import { calculateTTLTimestamp } from '../../shared';
import type { DynamoDBMessageItem } from '../types';

/**
 * Format a message index as a zero-padded 6-digit string
 * Supports up to 999,999 messages per session while maintaining sort order
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
 * Build or update a session metadata item
 *
 * @param userId - User identifier
 * @param sessionId - Session identifier
 * @param title - Session title
 * @param messageCount - New total message count
 * @param ttlDays - Optional TTL in days
 * @param isNew - Whether this is a new session (sets createdAt)
 */
export function buildMetadataUpdateExpression(
  title: string,
  messageCount: number,
  ttlDays?: number,
): {
  updateExpression: string;
  expressionAttributeValues: Record<string, any>;
} {
  const now = Date.now();
  const updateParts = [
    'updatedAt = :updatedAt',
    'messageCount = :messageCount',
    'itemType = :itemType',
    'title = if_not_exists(title, :title)',
    'createdAt = if_not_exists(createdAt, :createdAt)',
  ];
  const expressionAttributeValues: Record<string, any> = {
    ':updatedAt': now,
    ':createdAt': now,
    ':messageCount': messageCount,
    ':itemType': 'metadata',
    ':title': title,
  };

  if (ttlDays !== undefined) {
    updateParts.push('ttl = :ttl');
    expressionAttributeValues[':ttl'] = calculateTTLTimestamp(ttlDays);
  }

  return {
    updateExpression: `SET ${updateParts.join(', ')}`,
    expressionAttributeValues,
  };
}

/**
 * Build an atomic metadata update expression using DynamoDB's ADD operation
 * Atomically increments messageCount by incrementBy, preventing race conditions
 *
 * @param title - Session title (only set if not already present via if_not_exists)
 * @param incrementBy - Number to add to messageCount
 * @param ttlDays - Optional TTL in days
 * @returns UpdateExpression and ExpressionAttributeValues for DynamoDB update
 */
export function buildAtomicMetadataUpdate(
  title: string,
  incrementBy: number,
  ttlDays?: number,
): {
  updateExpression: string;
  expressionAttributeValues: Record<string, any>;
} {
  const now = Date.now();
  const setParts = [
    'updatedAt = :updatedAt',
    'itemType = :itemType',
    'title = if_not_exists(title, :title)',
    'createdAt = if_not_exists(createdAt, :createdAt)',
  ];
  const expressionAttributeValues: Record<string, any> = {
    ':updatedAt': now,
    ':createdAt': now,
    ':inc': incrementBy,
    ':itemType': 'metadata',
    ':title': title,
  };

  if (ttlDays !== undefined) {
    setParts.push('ttl = :ttl');
    expressionAttributeValues[':ttl'] = calculateTTLTimestamp(ttlDays);
  }

  return {
    updateExpression: `SET ${setParts.join(', ')} ADD messageCount :inc`,
    expressionAttributeValues,
  };
}
