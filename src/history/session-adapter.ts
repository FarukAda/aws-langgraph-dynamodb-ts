/**
 * Adapter that exposes a single (userId, sessionId) pair through the
 * LangChain `BaseListChatMessageHistory` contract so the DynamoDB-backed
 * history can be plugged into `RunnableWithMessageHistory` and anywhere else
 * that expects the standard interface.
 *
 * Use {@link DynamoDBChatMessageHistory.forSession} to obtain one; see that
 * method's JSDoc for the LangChain integration pattern.
 */

import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { BaseListChatMessageHistory } from '@langchain/core/chat_history';
import type { BaseMessage } from '@langchain/core/messages';

import { addMessageAction, addMessagesAction, clearAction, getMessagesAction } from './actions';

export interface DynamoDBSessionChatMessageHistoryParams {
  client: DynamoDBDocument;
  tableName: string;
  userId: string;
  sessionId: string;
  ttlDays?: number;
}

/**
 * Single-session LangChain `BaseListChatMessageHistory` backed by the same
 * DynamoDB table used by `DynamoDBChatMessageHistory`. Instances close over a
 * specific `(userId, sessionId)` pair; pass through
 * `RunnableWithMessageHistory` via a `GetSessionHistoryCallable`.
 */
export class DynamoDBSessionChatMessageHistory extends BaseListChatMessageHistory {
  lc_namespace = ['langchain', 'stores', 'message', 'dynamodb'];

  private readonly client: DynamoDBDocument;
  private readonly tableName: string;
  private readonly userId: string;
  private readonly sessionId: string;
  private readonly ttlDays?: number;

  constructor(params: DynamoDBSessionChatMessageHistoryParams) {
    super();
    this.client = params.client;
    this.tableName = params.tableName;
    this.userId = params.userId;
    this.sessionId = params.sessionId;
    this.ttlDays = params.ttlDays;
  }

  async getMessages(): Promise<BaseMessage[]> {
    return await getMessagesAction({
      client: this.client,
      tableName: this.tableName,
      userId: this.userId,
      sessionId: this.sessionId,
    });
  }

  async addMessage(message: BaseMessage): Promise<void> {
    await addMessageAction({
      client: this.client,
      tableName: this.tableName,
      userId: this.userId,
      sessionId: this.sessionId,
      message,
      ttlDays: this.ttlDays,
    });
  }

  async addMessages(messages: BaseMessage[]): Promise<void> {
    await addMessagesAction({
      client: this.client,
      tableName: this.tableName,
      userId: this.userId,
      sessionId: this.sessionId,
      messages,
      ttlDays: this.ttlDays,
    });
  }

  async clear(): Promise<void> {
    await clearAction({
      client: this.client,
      tableName: this.tableName,
      userId: this.userId,
      sessionId: this.sessionId,
    });
  }
}
