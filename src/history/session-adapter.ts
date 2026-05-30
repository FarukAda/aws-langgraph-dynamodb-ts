import { BaseListChatMessageHistory } from '@langchain/core/chat_history';
import type { BaseMessage } from '@langchain/core/messages';

/** The session-scoped operations a single-session adapter delegates to. */
export interface SessionBackend {
  getMessages(sessionId: string): Promise<BaseMessage[]>;
  addMessages(sessionId: string, messages: BaseMessage[]): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

/**
 * Single-session view over a {@link SessionBackend}, implementing LangChain's
 * `BaseListChatMessageHistory` so it can drive `RunnableWithMessageHistory`.
 */
export class DynamoDBSessionChatMessageHistory extends BaseListChatMessageHistory {
  lc_namespace = ['langchain', 'stores', 'message', 'dynamodb'];

  constructor(
    private readonly backend: SessionBackend,
    private readonly sessionId: string,
  ) {
    super();
  }

  getMessages(): Promise<BaseMessage[]> {
    return this.backend.getMessages(this.sessionId);
  }

  addMessage(message: BaseMessage): Promise<void> {
    return this.backend.addMessages(this.sessionId, [message]);
  }

  addMessages(messages: BaseMessage[]): Promise<void> {
    return this.backend.addMessages(this.sessionId, messages);
  }

  clear(): Promise<void> {
    return this.backend.clear(this.sessionId);
  }
}
