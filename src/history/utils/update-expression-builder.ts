/**
 * Update expression builder for chat message history
 * Provides centralized logic for building DynamoDB update expressions
 */

import type { BaseMessage } from '@langchain/core/messages';

import { calculateTTLTimestamp } from '../../shared';

/**
 * Parameters for building message update expression
 */
export interface BuildMessageUpdateExpressionParams {
  /** Single message or array of messages to add */
  messages: BaseMessage | BaseMessage[];
  /** Optional session title */
  title?: string;
  /** Optional TTL in days */
  ttlDays?: number;
}

/**
 * Result of building update expression
 */
export interface UpdateExpressionResult {
  /** DynamoDB UpdateExpression string */
  updateExpression: string;
  /** Expression attribute values */
  expressionAttributeValues: Record<string, any>;
}

/**
 * Build DynamoDB update expression for adding messages to a session
 * Handles both single messages and message arrays
 *
 * @param params - Parameters for building the expression
 * @returns Update expression and attribute values
 */
export function buildMessageUpdateExpression(
  params: BuildMessageUpdateExpressionParams,
): UpdateExpressionResult {
  const { messages, title, ttlDays } = params;
  const now = Date.now();

  const isArray = Array.isArray(messages);
  const messageArray = isArray ? messages : [messages];
  const messageCount = messageArray.length;

  // Build update expression parts
  const updateExpressionParts: string[] = ['updatedAt = :updatedAt'];
  const expressionAttributeValues: Record<string, any> = {
    ':updatedAt': now,
    ':createdAt': now,
    ':emptyList': [],
    ':zero': 0,
  };

  // Add title if provided
  if (title) {
    updateExpressionParts.push('title = if_not_exists(title, :title)');
    expressionAttributeValues[':title'] = title;
  }

  // Add messages
  if (isArray) {
    updateExpressionParts.push(
      'messages = list_append(if_not_exists(messages, :emptyList), :messages)',
    );
    updateExpressionParts.push('messageCount = if_not_exists(messageCount, :zero) + :messageCount');
    expressionAttributeValues[':messages'] = messageArray;
    expressionAttributeValues[':messageCount'] = messageCount;
  } else {
    updateExpressionParts.push(
      'messages = list_append(if_not_exists(messages, :emptyList), :message)',
    );
    updateExpressionParts.push('messageCount = if_not_exists(messageCount, :zero) + :one');
    expressionAttributeValues[':message'] = messageArray;
    expressionAttributeValues[':one'] = 1;
  }

  // Add TTL if configured
  if (ttlDays !== undefined) {
    updateExpressionParts.push('ttl = :ttl');
    expressionAttributeValues[':ttl'] = calculateTTLTimestamp(ttlDays);
  }

  // Build final update expression
  const updateExpression = `SET ${updateExpressionParts.join(', ')}, createdAt = if_not_exists(createdAt, :createdAt)`;

  return {
    updateExpression,
    expressionAttributeValues,
  };
}
