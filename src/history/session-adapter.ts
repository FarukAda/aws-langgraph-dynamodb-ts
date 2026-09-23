import { BaseListChatMessageHistory } from '@langchain/core/chat_history';
import type { BaseMessage } from '@langchain/core/messages';

import { guardPublic } from '../shared/errors/boundary';
import { assertMembers } from '../shared/validation/collaborators';
import { allKeysOf, assertShape } from '../shared/validation/option-shape';
import { validateMessageWindow, validateSessionId } from './internal/validation';

/** The read window an adapter applies to every `getMessages`. */
export type AdapterWindow = { limit?: number };

/** Every key {@link AdapterWindow} declares, compiler-checked against its type. */
const ADAPTER_WINDOW_KEYS = allKeysOf<AdapterWindow>({ limit: 'limit' });

/** The session-scoped operations a single-session adapter delegates to. */
export interface SessionBackend {
  getMessages(sessionId: string, window?: AdapterWindow): Promise<BaseMessage[]>;
  addMessages(sessionId: string, messages: BaseMessage[]): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

/** {@link SessionBackend}'s own members, the ones this adapter calls. */
const SESSION_BACKEND_MEMBERS: readonly string[] = ['getMessages', 'addMessages', 'clear'];

/**
 * Single-session view over a {@link SessionBackend}, implementing LangChain's
 * `BaseListChatMessageHistory` so it can drive `RunnableWithMessageHistory`.
 * A `window` bounds what every read hands the chain — `{ limit: 50 }` feeds it
 * the newest fifty messages instead of the whole session.
 */
export class DynamoDBSessionChatMessageHistory extends BaseListChatMessageHistory {
  lc_namespace = ['langchain', 'stores', 'message', 'dynamodb'];

  /**
   * Accepts: `backend` — the multi-session adapter this view delegates to,
   * checked structurally for {@link SessionBackend}'s own members. `sessionId`
   * — the one session it is bound to, validated the same way every other
   * adapter method validates a session id. `window` — bounds every read it
   * performs; when given, only the `limit` key `AdapterWindow` declares, an
   * integer from 1 to the package's page ceiling. `0` is refused: this window
   * is what `RunnableWithMessageHistory` reads on every invocation, and an
   * empty one is indistinguishable from a conversation that never happened.
   *
   * Returns: the view. Normally built through
   * `DynamoDBChatMessageHistory.forSession`, which is the supported route.
   *
   * Throws: `VALIDATION` naming `backend`, `backend.<member>` for the first
   * missing method, `sessionId`, `window` for a window that is not an object,
   * `window.<key>` for a key `AdapterWindow` does not declare, or `limit`. Checking here reports a caller's mistake at
   * construction instead of rebranding it as an upstream failure on first use.
   */
  constructor(
    private readonly backend: SessionBackend,
    private readonly sessionId: string,
    private readonly window?: AdapterWindow,
  ) {
    super();
    assertMembers(backend, SESSION_BACKEND_MEMBERS, 'backend');
    validateSessionId(sessionId);
    if (window !== undefined) {
      assertShape(window, ADAPTER_WINDOW_KEYS, 'window');
      validateMessageWindow(window);
    }
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
   * Throws: whatever the backend's `getMessages` throws, wrapped with
   * the code the classifier assigns unless it is already one of this library's
   * own errors.
   */
  getMessages(): Promise<BaseMessage[]> {
    return guardPublic('session.getMessages', () =>
      this.backend.getMessages(this.sessionId, this.window),
    );
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
    return guardPublic('session.addMessage', () =>
      this.backend.addMessages(this.sessionId, [message]),
    );
  }

  /**
   * Append messages to this session.
   *
   * Accepts: `messages` — LangChain messages; an empty list writes nothing.
   *
   * Returns: nothing, and only once every message has landed.
   *
   * Throws: whatever the backend's `addMessages` throws, wrapped with
   * the code the classifier assigns unless it is already one of this library's
   * own errors.
   *
   * Guarantees: the window bounds what is *read*, never what is written — the
   * session keeps every message appended to it.
   */
  addMessages(messages: BaseMessage[]): Promise<void> {
    return guardPublic('session.addMessages', () =>
      this.backend.addMessages(this.sessionId, messages),
    );
  }

  /**
   * Delete this session's messages, metadata and offloaded objects.
   *
   * Accepts: nothing.
   *
   * Returns: nothing. Clearing a session that does not exist is not an error.
   *
   * Throws: whatever the backend's `clear` throws, wrapped with the code the
   * classifier assigns unless it is already one of this library's own errors.
   *
   * Guarantees: the whole session goes, not the window.
   * `BaseListChatMessageHistory` declares `clear()`, and a chain that calls it
   * is asking for exactly that.
   */
  clear(): Promise<void> {
    return guardPublic('session.clear', () => this.backend.clear(this.sessionId));
  }
}
