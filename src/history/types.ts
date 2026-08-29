import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import type { PayloadDescriptor } from '../shared/codec/codec';
import type { BaseAdapterOptions, CodecOptions } from '../shared/options';

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

/** Summary of a stored chat session. */
export interface SessionMetadata {
  sessionId: string;
  title?: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

/** A single stored chat message item (one per message, ordered by its ULID). */
export interface ChatMessageItem {
  PK: string;
  SK: string;
  sessionId: string;
  message: PayloadDescriptor;
  ttl?: number;
}

/** The per-session metadata item, updated atomically as messages are appended. */
export interface ChatSessionItem {
  PK: string;
  SK: string;
  sessionId: string;
  messageCount: number;
  title?: string;
  createdAt: string;
  updatedAt: string;
  ttl?: number;
}
