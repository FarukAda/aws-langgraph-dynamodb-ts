import type { BaseMessage } from '@langchain/core/messages';

import { resolveTtlDaysCeil } from '../shared/validation/ttl';
import { addMessages as addMessagesAction } from './actions/add-messages';
import { clearSession } from './actions/clear';
import { getMessages as getMessagesAction } from './actions/get-messages';
import { listSessions as listSessionsAction } from './actions/list-sessions';
import { reconcileMessageCount as reconcileMessageCountAction } from './actions/reconcile-count';
import { type HistoryContext, setUpHistory } from './internal/setup';
import { DynamoDBSessionChatMessageHistory } from './session-adapter';
import type { DynamoDBChatMessageHistoryOptions, SessionMetadata } from './types';

/**
 * DynamoDB-backed multi-session chat history. Each message is its own item
 * (ordered by a monotonic ULID, compressed / S3-offloaded as needed) alongside a
 * per-session metadata item; every message in a session shares one uniform TTL.
 * Appends are O(1) and lock-free. Use {@link forSession} to get a single-session
 * LangChain adapter.
 */
export class DynamoDBChatMessageHistory {
  private readonly context: HistoryContext;
  private readonly ownsClient: boolean;
  private readonly ddbClient: ReturnType<typeof setUpHistory>['ddbClient'];

  constructor(options: DynamoDBChatMessageHistoryOptions) {
    const setup = setUpHistory(options);
    this.context = setup.context;
    this.ownsClient = setup.ownsClient;
    this.ddbClient = setup.ddbClient;
  }

  /** Get a session's messages in order. */
  getMessages(sessionId: string): Promise<BaseMessage[]> {
    return getMessagesAction(this.context, sessionId);
  }

  /** Append messages to a session. */
  addMessages(sessionId: string, messages: BaseMessage[]): Promise<void> {
    return addMessagesAction(this.context, sessionId, messages);
  }

  /** Append a single message to a session. */
  addMessage(sessionId: string, message: BaseMessage): Promise<void> {
    return addMessagesAction(this.context, sessionId, [message]);
  }

  /** Delete a session and any offloaded payload. */
  clear(sessionId: string): Promise<void> {
    return clearSession(this.context, sessionId);
  }

  /** List all sessions as metadata summaries. */
  listSessions(): Promise<SessionMetadata[]> {
    return listSessionsAction(this.context);
  }

  /**
   * Recompute and repair a session's `messageCount` from the stored messages.
   * A maintenance tool for external corruption; run it when the session is idle.
   */
  reconcileMessageCount(sessionId: string): Promise<number> {
    return reconcileMessageCountAction(this.context, sessionId);
  }

  /** Get a single-session LangChain adapter for `sessionId`. */
  forSession(sessionId: string): DynamoDBSessionChatMessageHistory {
    return new DynamoDBSessionChatMessageHistory(this, sessionId);
  }

  /** Release owned resources (the underlying client and any S3 client). */
  destroy(): void {
    this.context.offloader?.destroy();
    if (this.ownsClient) this.ddbClient?.destroy();
  }

  /**
   * Best-effort provision an S3 lifecycle expiration rule matching the
   * configured TTL, so offloaded objects don't outlive their DynamoDB item
   * forever. No-ops when S3 offload or TTL isn't configured. Requires the
   * `s3:GetLifecycleConfiguration`/`s3:PutLifecycleConfiguration` bucket-level
   * permissions (broader than the object-level CRUD the rest of S3 offload
   * needs) — call this once during deployment/provisioning, not per-request.
   */
  async ensureS3LifecycleRule(): Promise<void> {
    if (!this.context.offloader || !this.context.ttl) return;
    await this.context.offloader.ensureLifecycleRule(resolveTtlDaysCeil(this.context.ttl));
  }
}
