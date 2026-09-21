import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import type { PayloadDescriptor } from '../shared/codec/codec';
import type { BaseAdapterOptions, CancelOptions, CodecOptions } from '../shared/options';

/** Options for {@link DynamoDBChatMessageHistory}. */
export type DynamoDBChatMessageHistoryOptions = BaseAdapterOptions &
  CodecOptions & {
    /** Optional serializer override (defaults to the JSON serializer). */
    serde?: SerializerProtocol;
    /**
     * What `getMessages` does when a stored message cannot be decoded — a
     * decompression-guard trip, an unsupported `serdeType` after a config
     * change, or genuinely corrupted bytes. `'skip'` (the default) drops the
     * item, logs it at `error` with its sort key so an operator can locate
     * it, and returns the rest; `'throw'` fails the whole read, which is
     * all-or-nothing but leaves the session unreadable until the bad row is
     * removed out of band.
     */
    onCorruptMessage?: CorruptMessagePolicy;
  };

/** How `getMessages` handles an item it cannot decode. */
export type CorruptMessagePolicy = 'skip' | 'throw';

/**
 * Which slice of a session `getMessages` returns. Both bounds are optional
 * and combine: `{ limit: 50, before }` is the fifty messages just before
 * `before`.
 */
export interface MessageWindow {
  /**
   * Return only the newest `limit` messages — still in chronological order. An
   * integer from 1 to `MAX_PAGE_LIMIT` (10,000): the page rule every `limit` in
   * this package follows, with the one floor of 1 it has. `0` is refused rather
   * than answered with nothing, since for a window into a conversation it is
   * far more likely a bug than a request — and the empty window it would
   * produce is what a chain reads as the whole session.
   */
  limit?: number;
  /** Return only messages appended before this instant (millisecond precision). */
  before?: Date;
}

/** Options for `getMessages`: the read window plus cancellation. */
export type GetMessagesOptions = MessageWindow & CancelOptions;

/** Options for `listSessions`: the page, the scan caps, and cancellation. */
export interface ListSessionsOptions extends CancelOptions {
  /**
   * How many sessions to return, newest-updated first; an integer from 0 to
   * `MAX_PAGE_LIMIT` (10,000).
   *
   * With a configured `indexName` it is the page size and defaults to 100.
   * Without one the read is a table scan that cannot be paged: an explicit
   * limit still selects the newest N, but omitting it returns every session,
   * because there would be no cursor to fetch the rest with. `0` returns an
   * empty page on either path and reads neither.
   */
  limit?: number;
  /**
   * Opaque cursor from a previous page. Requires a configured `indexName` —
   * without the index there is no position to resume from, and passing one is
   * refused rather than answered with the first page again.
   */
  cursor?: string;
  /** Cap on scan pages before `ResultTruncatedError` (default 1000). Scan path only. */
  maxIterations?: number;
  /** Cap on rows read into memory before `ResultTruncatedError` (default 10 000). Scan path only. */
  maxItems?: number;
}

/** One page of {@link SessionMetadata}, and where the next one resumes. */
export interface SessionPage {
  sessions: SessionMetadata[];
  /** Absent when this page is the last one, or when the read was a scan. */
  nextCursor?: string;
}

/** Summary of a stored chat session. */
export interface SessionMetadata {
  sessionId: string;
  title?: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  /** When the session's TTL expires, as an ISO-8601 instant; absent when no TTL is stored. */
  expiresAt?: string;
}

/** A single stored chat message item (one per message, ordered by its ULID). */
export interface ChatMessageItem {
  PK: string;
  SK: string;
  /** Row format version; absent on rows written before it existed (see `row-version.ts`). */
  v?: number;
  sessionId: string;
  message: PayloadDescriptor;
  ttl?: number;
}

/** The per-session metadata item, updated atomically as messages are appended. */
export interface ChatSessionItem {
  PK: string;
  SK: string;
  /** Row format version; absent on rows written before it existed (see `row-version.ts`). */
  v?: number;
  sessionId: string;
  messageCount: number;
  title?: string;
  createdAt: string;
  updatedAt: string;
  ttl?: number;
}
