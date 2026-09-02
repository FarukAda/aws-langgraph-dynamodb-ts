import type { BaseMessage } from '@langchain/core/messages';

import { guardPublic } from '../shared/errors/boundary';
import type { CancelOptions } from '../shared/options';
import { lifecycleExpirationDays } from '../shared/validation/ttl';
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
 * LangChain adapter. Every public method is the library's error boundary — a
 * raw AWS SDK error escaping an action surfaces as an `UpstreamError`.
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
  getMessages(sessionId: string, options?: CancelOptions): Promise<BaseMessage[]> {
    return guardPublic('history.getMessages', () =>
      getMessagesAction(this.context, sessionId, options?.signal),
    );
  }

  /** Append messages to a session. */
  addMessages(sessionId: string, messages: BaseMessage[], options?: CancelOptions): Promise<void> {
    return guardPublic('history.addMessages', () =>
      addMessagesAction(this.context, sessionId, messages, options?.signal),
    );
  }

  /** Append a single message to a session. */
  addMessage(sessionId: string, message: BaseMessage, options?: CancelOptions): Promise<void> {
    return guardPublic('history.addMessage', () =>
      addMessagesAction(this.context, sessionId, [message], options?.signal),
    );
  }

  /** Delete a session and any offloaded payload. */
  clear(sessionId: string, options?: CancelOptions): Promise<void> {
    return guardPublic('history.clear', () => clearSession(this.context, sessionId, options));
  }

  /** List all sessions as metadata summaries. */
  listSessions(
    options?: { maxIterations?: number; maxItems?: number } & CancelOptions,
  ): Promise<SessionMetadata[]> {
    return guardPublic('history.listSessions', () => listSessionsAction(this.context, options));
  }

  /**
   * Recompute and repair a session's `messageCount` from the stored messages.
   * A maintenance tool for external corruption; run it when the session is idle.
   */
  reconcileMessageCount(sessionId: string, options?: CancelOptions): Promise<number> {
    return guardPublic('history.reconcileMessageCount', () =>
      reconcileMessageCountAction(this.context, sessionId, options?.signal),
    );
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
   * Provision an S3 lifecycle expiration rule matching the configured TTL, so
   * offloaded objects don't outlive their DynamoDB item forever. No-ops when
   * S3 offload or TTL isn't configured; throws when the bucket cannot be read
   * or written. Requires the `s3:GetLifecycleConfiguration` /
   * `s3:PutLifecycleConfiguration` bucket-level permissions (broader than the
   * object-level CRUD the rest of S3 offload needs) — call this once during
   * deployment/provisioning, not per-request.
   */
  async ensureS3LifecycleRule(): Promise<void> {
    return guardPublic('history.ensureS3LifecycleRule', async () => {
      if (!this.context.offloader || !this.context.ttl) return;
      await this.context.offloader.ensureLifecycleRule(lifecycleExpirationDays(this.context.ttl));
    });
  }
}
