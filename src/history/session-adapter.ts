import { BaseListChatMessageHistory } from '@langchain/core/chat_history';
import type { BaseMessage } from '@langchain/core/messages';

/** The read window an adapter applies to every `getMessages`. */
export type AdapterWindow = { limit?: number };

/** The session-scoped operations a single-session adapter delegates to. */
export interface SessionBackend {
  getMessages(sessionId: string, window?: AdapterWindow): Promise<BaseMessage[]>;
  addMessages(sessionId: string, messages: BaseMessage[]): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

/**
 * Single-session view over a {@link SessionBackend}, implementing LangChain's
 * `BaseListChatMessageHistory` so it can drive `RunnableWithMessageHistory`.
 * A `window` bounds what every read hands the chain — `{ limit: 50 }` feeds it
 * the newest fifty messages instead of the whole session.
 */
export class DynamoDBSessionChatMessageHistory extends BaseListChatMessageHistory {
  lc_namespace = ['langchain', 'stores', 'message', 'dynamodb'];

  /**
   * Accepts: `backend` — the multi-session adapter this view delegates to.
   * `sessionId` — the one session it is bound to. `window` — bounds every read
   * it performs.
   *
   * Returns: the view. Normally built through
   * `DynamoDBChatMessageHistory.forSession`, which is the supported route.
   *
   * Throws: nothing; it opens nothing and reads nothing.
   */
  constructor(
    private readonly backend: SessionBackend,
    private readonly sessionId: string,
    private readonly window?: AdapterWindow,
  ) {
    super();
  }

  /**
   * This session's messages in chronological order.
   *
   * Accepts: nothing — the session and the window are fixed at construction,
   * which is what `BaseListChatMessageHistory` requires.
   *
   * Returns: the messages, bounded by the adapter's window. LangChain calls
   * this on every chain invocation, so the window is what keeps a long session
   * from growing the prompt without limit.
   *
   * Throws: whatever the backend's `getMessages` throws.
   */
  getMessages(): Promise<BaseMessage[]> {
    return this.backend.getMessages(this.sessionId, this.window);
  }

  /**
   * Append one message to this session.
   *
   * Accepts: `message` — a LangChain message.
   *
   * Returns: nothing.
   *
   * Throws: as {@link addMessages}.
   */
  addMessage(message: BaseMessage): Promise<void> {
    return this.backend.addMessages(this.sessionId, [message]);
  }

  /**
   * Append messages to this session.
   *
   * Accepts: `messages` — LangChain messages; an empty list writes nothing.
   *
   * Returns: nothing, and only once every message has landed.
   *
   * Throws: whatever the backend's `addMessages` throws.
   *
   * Guarantees: the window bounds what is *read*, never what is written — the
   * session keeps every message appended to it.
   */
  addMessages(messages: BaseMessage[]): Promise<void> {
    return this.backend.addMessages(this.sessionId, messages);
  }

  /**
   * Delete this session's messages, metadata and offloaded objects.
   *
   * Accepts: nothing.
   *
   * Returns: nothing. Clearing a session that does not exist is not an error.
   *
   * Throws: whatever the backend's `clear` throws.
   *
   * Guarantees: the whole session goes, not the window.
   * `BaseListChatMessageHistory` declares `clear()`, and a chain that calls it
   * is asking for exactly that.
   */
  clear(): Promise<void> {
    return this.backend.clear(this.sessionId);
  }
}
