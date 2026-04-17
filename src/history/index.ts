/**
 * DynamoDB-based chat message history implementation for LangChain
 * Provides persistent storage for chat messages with automatic title generation
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { BaseMessage } from '@langchain/core/messages';

import { resolveDynamoDBClient } from '../shared';
import {
  getMessagesAction,
  addMessageAction,
  addMessagesAction,
  clearAction,
  listSessionsAction,
} from './actions';
import { DynamoDBSessionChatMessageHistory } from './session-adapter';
import type { DynamoDBChatMessageHistoryOptions, SessionMetadata } from './types';

/**
 * DynamoDB-backed chat message history with per-message-item storage.
 *
 * @remarks
 * Each session is capped at ~999 999 messages by the 6-digit message-index
 * sort-key padding. Sessions approaching this bound should be sharded by the
 * caller; see `formatMessageIndex` for details.
 */
export class DynamoDBChatMessageHistory {
  private readonly ddbClient: DynamoDBClient | undefined;
  private readonly client: DynamoDBDocument;
  private readonly tableName: string;
  private readonly ttlDays?: number;
  private readonly ownsClient: boolean;

  /**
   * Create a new DynamoDB chat message history instance
   *
   * @param options - Configuration options for the chat message history
   * @param options.tableName - Name of the DynamoDB table to use
   * @param options.ttlDays - Optional TTL in days for automatic cleanup (1-1825 days)
   * @param options.clientConfig - Optional DynamoDB client configuration
   * @param options.client - Optional pre-built DynamoDBDocument client (takes precedence over clientConfig)
   */
  constructor(options: DynamoDBChatMessageHistoryOptions) {
    ({
      ddbClient: this.ddbClient,
      client: this.client,
      ownsClient: this.ownsClient,
    } = resolveDynamoDBClient(options));
    this.tableName = options.tableName;
    this.ttlDays = options.ttlDays;
  }

  /**
   * Release underlying DynamoDB client resources.
   * Call this when the history is no longer needed to prevent resource leaks.
   * Skips cleanup if a shared client was injected via options.
   */
  destroy(): void {
    if (this.ownsClient && this.ddbClient) {
      this.ddbClient.destroy();
    }
  }

  /**
   * Get all messages for a session
   * Messages are returned in chronological order
   *
   * @param userId - User identifier
   * @param sessionId - Session identifier
   * @returns Array of BaseMessage objects in chronological order
   * @throws Error if the operation fails or validation fails
   */
  async getMessages(
    userId: string,
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<BaseMessage[]> {
    return await getMessagesAction({
      client: this.client,
      tableName: this.tableName,
      userId,
      sessionId,
      signal: options.signal,
    });
  }

  /**
   * Add a single message to a session
   * Generates title from the first message if this is a new session
   *
   * @param userId - User identifier
   * @param sessionId - Session identifier
   * @param message - The BaseMessage to add to the session
   * @param title - Optional session title (auto-generated from the first message if not provided)
   * @throws Error if the operation fails or validation fails
   */
  async addMessage(
    userId: string,
    sessionId: string,
    message: BaseMessage,
    title?: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await addMessageAction({
      client: this.client,
      tableName: this.tableName,
      userId,
      sessionId,
      message,
      title,
      ttlDays: this.ttlDays,
      signal: options.signal,
    });
  }

  /**
   * Add multiple messages to a session
   * Generates title from the first message if this is a new session
   * Preferred over calling addMessage multiple times for performance
   *
   * @param userId - User identifier
   * @param sessionId - Session identifier
   * @param messages - Array of BaseMessage objects to add
   * @param title - Optional session title (auto-generated from the first message if not provided)
   * @throws Error if the operation fails or validation fails
   */
  async addMessages(
    userId: string,
    sessionId: string,
    messages: BaseMessage[],
    title?: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await addMessagesAction({
      client: this.client,
      tableName: this.tableName,
      userId,
      sessionId,
      messages,
      title,
      ttlDays: this.ttlDays,
      signal: options.signal,
    });
  }

  /**
   * Clear all messages in a session
   * Deletes the session item from DynamoDB
   *
   * @param userId - User identifier
   * @param sessionId - Session identifier
   * @throws Error if the operation fails or validation fails
   */
  async clear(
    userId: string,
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await clearAction({
      client: this.client,
      tableName: this.tableName,
      userId,
      sessionId,
      signal: options.signal,
    });
  }

  /**
   * List all sessions for a user, sorted by most recent
   * Returns metadata only (excludes messages for performance)
   *
   * @param userId - User ID to list sessions for
   * @param limit - Optional maximum number of sessions to return (default: no limit)
   * @returns Array of session metadata, sorted by most recent first
   * @throws Error if the operation fails or validation fails
   */
  async listSessions(
    userId: string,
    limit?: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionMetadata[]> {
    return await listSessionsAction({
      client: this.client,
      tableName: this.tableName,
      userId,
      limit,
      signal: options.signal,
    });
  }

  /**
   * Bind this store to a single `(userId, sessionId)` pair and return a
   * `BaseListChatMessageHistory` compatible instance — the shape LangChain's
   * `RunnableWithMessageHistory` expects from `getMessageHistory(sessionId)`.
   *
   * @example
   * ```ts
   * const store = new DynamoDBChatMessageHistory({ tableName });
   * new RunnableWithMessageHistory({
   *   runnable,
   *   getMessageHistory: (sessionId) => store.forSession(userId, sessionId),
   *   // ...
   * });
   * ```
   */
  forSession(userId: string, sessionId: string): DynamoDBSessionChatMessageHistory {
    return new DynamoDBSessionChatMessageHistory({
      client: this.client,
      tableName: this.tableName,
      userId,
      sessionId,
      ttlDays: this.ttlDays,
    });
  }
}

export { DynamoDBSessionChatMessageHistory } from './session-adapter';
