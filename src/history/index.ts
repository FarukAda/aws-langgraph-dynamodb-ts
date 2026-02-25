/**
 * DynamoDB-based chat message history implementation for LangChain
 * Provides persistent storage for chat messages with automatic title generation
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { BaseMessage } from '@langchain/core/messages';

import {
  getMessagesAction,
  addMessageAction,
  addMessagesAction,
  clearAction,
  listSessionsAction,
} from './actions';
import type { DynamoDBChatMessageHistoryOptions, SessionMetadata } from './types';

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
    if (options.client) {
      this.client = options.client;
      this.ddbClient = undefined;
      this.ownsClient = false;
    } else {
      this.ddbClient = new DynamoDBClient(options.clientConfig || {});
      this.client = DynamoDBDocument.from(this.ddbClient);
      this.ownsClient = true;
    }
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
  async getMessages(userId: string, sessionId: string): Promise<BaseMessage[]> {
    return await getMessagesAction({
      client: this.client,
      tableName: this.tableName,
      userId,
      sessionId,
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
  ): Promise<void> {
    await addMessageAction({
      client: this.client,
      tableName: this.tableName,
      userId,
      sessionId,
      message,
      title,
      ttlDays: this.ttlDays,
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
  ): Promise<void> {
    await addMessagesAction({
      client: this.client,
      tableName: this.tableName,
      userId,
      sessionId,
      messages,
      title,
      ttlDays: this.ttlDays,
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
  async clear(userId: string, sessionId: string): Promise<void> {
    await clearAction({
      client: this.client,
      tableName: this.tableName,
      userId,
      sessionId,
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
  async listSessions(userId: string, limit?: number): Promise<SessionMetadata[]> {
    return await listSessionsAction({
      client: this.client,
      tableName: this.tableName,
      userId,
      limit,
    });
  }
}
