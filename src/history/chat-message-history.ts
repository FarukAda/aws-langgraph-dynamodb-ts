import type { BaseMessage } from '@langchain/core/messages';

import { guardPublic } from '../shared/errors/boundary';
import type { CancelOptions } from '../shared/options';
import { releaseOwned } from '../shared/release';
import { assertCancelOptions } from '../shared/validation/method-keys';
import { lifecycleExpirationDays } from '../shared/validation/ttl';
import { addMessages as addMessagesAction } from './actions/add-messages';
import { clearSession } from './actions/clear';
import { getMessages as getMessagesAction } from './actions/get-messages';
import { listSessions as listSessionsAction } from './actions/list-sessions';
import { reconcileMessageCount as reconcileMessageCountAction } from './actions/reconcile-count';
import { type HistoryContext, setUpHistory } from './internal/setup';
import { type AdapterWindow, DynamoDBSessionChatMessageHistory } from './session-adapter';
import type {
  DynamoDBChatMessageHistoryOptions,
  GetMessagesOptions,
  ListSessionsOptions,
  SessionPage,
} from './types';

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

  /**
   * Accepts: `options` — validated here, so a misconfiguration surfaces at
   * construction rather than on the first request.
   *
   * Returns: an adapter that owns the client it built, or borrows the one it
   * was given.
   *
   * Throws: ValidationError naming the offending option.
   *
   * Guarantees: no I/O. Constructing the adapter issues no request.
   */
  constructor(options: DynamoDBChatMessageHistoryOptions) {
    const setup = setUpHistory(options);
    this.context = setup.context;
    this.ownsClient = setup.ownsClient;
    this.ddbClient = setup.ddbClient;
  }

  /**
   * Get a session's messages in chronological order.
   *
   * Accepts: `sessionId` — validated. `options.limit` — an integer from 1 to
   * `MAX_PAGE_LIMIT` (10,000); only the newest that many messages. `0` is
   * refused rather than answered with an empty conversation, which is the one
   * place this package refuses a `limit` of zero. `options.before` — a valid
   * `Date`; only messages appended before that instant. Neither given reads
   * the whole session. `options.signal` — aborts the reads.
   *
   * Returns: the messages, oldest first. A session that does not exist and one
   * whose messages have all expired both return nothing.
   *
   * Throws: ValidationError for a malformed session id or window, an invalid
   * `signal`, or naming `options.<key>` for a key this package does not read;
   * ValidationError naming `s3Key` for a row addressing an object outside the
   * session's own path, whatever the corruption policy;
   * `FORMAT_UNSUPPORTED` for a row, or a payload, a newer release wrote;
   * UpstreamError;
   * AbortError; and, under `onCorruptMessage: 'throw'`, the decode error of a
   * corrupt row.
   *
   * Guarantees: strongly consistent, so the turn just appended is visible.
   * Expired messages are filtered on read, so the history is never stale.
   * @remarks One query page plus one S3 download per offloaded message.
   */
  getMessages(sessionId: string, options?: GetMessagesOptions): Promise<BaseMessage[]> {
    return guardPublic('history.getMessages', () =>
      getMessagesAction(this.context, sessionId, options),
    );
  }

  /**
   * Append messages to a session.
   *
   * Accepts: `sessionId` — validated. `messages` — LangChain messages; an empty
   * list writes nothing and is not an error. `options.signal` — aborts between
   * chunks.
   *
   * Returns: nothing, and only once every message has landed.
   *
   * Throws: ValidationError naming `messages`, for a value that is not itself
   * an array, or, with the offending index, for an element that is not a
   * message or one that could never be read back; or naming `signal` or
   * `options.<key>` for a key this package does not read;
   * CompensationFailedError when a later chunk fails and the rollback fails
   * too; RetryExhaustedError after 18 contended attempts; UpstreamError;
   * AbortError.
   *
   * Guarantees: a caller observes all messages or none. One transaction per
   * chunk of up to 99 keeps `messageCount` exact. Lock-free and safe under
   * concurrent appends to one session; every message shares the session's TTL
   * when one is configured.
   */
  addMessages(sessionId: string, messages: BaseMessage[], options?: CancelOptions): Promise<void> {
    return guardPublic('history.addMessages', () => {
      assertCancelOptions(options);
      return addMessagesAction(this.context, sessionId, messages, options?.signal);
    });
  }

  /**
   * Append one message.
   *
   * Accepts: as {@link addMessages}, for a single message.
   *
   * Returns: nothing.
   *
   * Throws: as {@link addMessages}.
   */
  addMessage(sessionId: string, message: BaseMessage, options?: CancelOptions): Promise<void> {
    return guardPublic('history.addMessage', () => {
      assertCancelOptions(options);
      return addMessagesAction(this.context, sessionId, [message], options?.signal);
    });
  }

  /**
   * Delete a session's messages, metadata and offloaded objects.
   *
   * Accepts: `sessionId` — validated. `options.signal` — aborts between pages.
   *
   * Returns: nothing. Clearing a session that does not exist is not an error.
   *
   * Throws: ValidationError for a malformed session id, an invalid `signal`,
   * or an `options.<key>` this package does not read;
   * BatchWriteAllIncompleteError when a row's delete fails, counting rows
   * rather than batches; UpstreamError; AbortError when the signal fires,
   * which is what a cancel surfaces as rather than an incomplete delete, even
   * when it fires part-way through the pass. A row refused because it
   * was rewritten after the partition read raises nothing: it is left in place,
   * reported at `warn`, and counted as skipped.
   *
   * Guarantees: a row this adapter did not write is left in place and logged,
   * and neither is a row rewritten since the read — an append landing during
   * the call moves the session row's own write id, so that row survives with
   * the session it belongs to instead of being removed under a live
   * conversation. Single pass: call it when the session is quiescent, since a
   * message appended while it runs may survive it, and the surviving session
   * row then over-counts until `reconcileMessageCount` repairs it.
   */
  clear(sessionId: string, options?: CancelOptions): Promise<void> {
    return guardPublic('history.clear', () => {
      assertCancelOptions(options);
      return clearSession(this.context, sessionId, options);
    });
  }

  /**
   * List every session as a metadata summary, most recently updated first.
   * With a configured `indexName` this reads each index shard newest-first,
   * merges the shards and pages by the opaque `nextCursor`. Without one it
   * falls back to a filtered table scan — cross-tenant by construction,
   * bounded by `maxItems` / `maxIterations`, and returning the newest `limit`
   * sessions, or every session when no limit is given, with no cursor.
   *
   * Accepts: `options.limit` — an integer from 0 to `MAX_PAGE_LIMIT` (10,000);
   * the page size with the index, the newest N without it, and `0` an empty
   * page read from neither. `options.cursor` — from a previous page,
   * and only with a configured `indexName`. `options.maxItems` /
   * `maxIterations` — caps on the scan path. `options.signal` — aborts the
   * reads.
   *
   * Returns: the page and, while rows may remain, a `nextCursor`. A page may
   * come back shorter than `limit` while more rows remain: expired and foreign
   * rows are dropped after the read. A cursor does not promise more rows:
   * DynamoDB can end a shard's page at its last row and still return a key to
   * continue from, and the page after such a cursor can come back empty. Stop
   * when `nextCursor` is absent, never when a page looks short.
   *
   * Throws: ValidationError naming `limit`, `cursor`, `maxItems`,
   * `maxIterations`, `signal`, or `options.<key>` for a key this package does
   * not read; ResultTruncatedError past either cap on the scan path, or for an
   * index shard whose pages do not end; `FORMAT_UNSUPPORTED` for a session row
   * a newer release wrote; UpstreamError; AbortError.
   *
   * Guarantees: with a configured `indexName` each shard is read one DynamoDB
   * page at a time, and its next page whenever it has no row buffered and the
   * page still needs one, so a shard can cost a query whose rows the page never
   * takes; at most `readConcurrency` shards are queried at once. Memory is the
   * page being built, up to `limit` rows and so bounded by
   * `MAX_PAGE_LIMIT` (10,000), plus at most one DynamoDB page per shard,
   * whatever the table holds.
   */
  listSessions(options?: ListSessionsOptions): Promise<SessionPage> {
    return guardPublic('history.listSessions', () => listSessionsAction(this.context, options));
  }

  /**
   * Recompute and repair a session's `messageCount` from the stored messages.
   * A maintenance tool for external corruption; run it when the session is idle.
   *
   * Accepts: `sessionId` — validated, and an existing session.
   * `options.signal` — aborts the reads.
   *
   * Returns: the count now stored, which is the number of messages a reader
   * would see.
   *
   * Throws: ValidationError for a malformed session id, an invalid `signal`,
   * or an `options.<key>` this package does not read; ConflictError when the
   * session does not exist or stayed busy through every attempt;
   * `FORMAT_UNSUPPORTED` for a message row a newer release wrote, which
   * `getMessages` refuses too; UpstreamError; AbortError.
   *
   * Guarantees: safe on a live session — the write is pinned to the value the
   * row held when the count was computed, so a concurrent append makes it
   * recount instead of clobbering the increment.
   */
  reconcileMessageCount(sessionId: string, options?: CancelOptions): Promise<number> {
    return guardPublic('history.reconcileMessageCount', () => {
      assertCancelOptions(options);
      return reconcileMessageCountAction(this.context, sessionId, options?.signal);
    });
  }

  /**
   * Get a single-session LangChain adapter for `sessionId`.
   *
   * Accepts: `sessionId` — validated by the adapter's own constructor, the
   * same rule every other method applies. `window.limit` — bounds what the
   * adapter feeds the chain to the newest that many messages; validated the
   * same way.
   *
   * Returns: an adapter implementing `BaseListChatMessageHistory`, which is
   * what `RunnableWithMessageHistory` takes.
   *
   * Throws: ValidationError naming `sessionId`, `window` for a window that is
   * not an object, `window.<key>` for a key the adapter does not declare, or
   * `limit` — raised by the constructed adapter, so a bad id or window fails
   * here rather than on first use.
   */
  forSession(sessionId: string, window?: AdapterWindow): DynamoDBSessionChatMessageHistory {
    return new DynamoDBSessionChatMessageHistory(this, sessionId, window);
  }

  /**
   * Release owned resources.
   *
   * Accepts: nothing.
   *
   * Returns: nothing. Idempotent, and a no-op for a client the caller injected
   * — that one is theirs to close.
   *
   * Throws: whatever a resource's own `destroy` raises — but only after every
   * other one has been released, so a client that fails to close can no longer
   * strand the one behind it (see `releaseOwned`). It used to: an S3
   * client whose sockets were already gone threw first, and the DynamoDB client
   * this adapter built leaked for the life of the process. The clause read
   * "nothing this adapter raises", which a caller reads as nothing at all.
   */
  destroy(): void {
    releaseOwned([this.context.offloader, this.ownsClient ? this.ddbClient : undefined]);
  }

  /**
   * Provision an S3 lifecycle expiration rule matching the configured TTL, so
   * offloaded objects don't outlive their DynamoDB item forever.
   *
   * Accepts: nothing; the rule follows the configured `s3` and `ttl`. A no-op
   * without both.
   *
   * Returns: nothing. Installing a rule that is already there is a no-op too.
   *
   * Throws: ValidationError naming `s3.keyPrefix` on a rule-id collision;
   * UpstreamError when the bucket's lifecycle cannot be read or written.
   * @remarks Requires the bucket-level `s3:GetLifecycleConfiguration` /
   * `s3:PutLifecycleConfiguration` permissions, broader than the object-level
   * CRUD the rest of S3 offload needs — call it once during provisioning, not
   * per request.
   */
  async ensureS3LifecycleRule(): Promise<void> {
    return guardPublic('history.ensureS3LifecycleRule', async () => {
      if (!this.context.offloader || !this.context.ttl) return;
      await this.context.offloader.ensureLifecycleRule(
        lifecycleExpirationDays(this.context.ttl),
        this.context.logger,
      );
    });
  }
}
