import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import type { PayloadDescriptor } from '../shared/codec/codec';
import type { BaseAdapterOptions, CodecOptions } from '../shared/options';

/** Options for {@link DynamoDBChatMessageHistory}. */
export type DynamoDBChatMessageHistoryOptions = BaseAdapterOptions &
  CodecOptions & {
    /** Optional serializer override (defaults to the JSON serializer). */
    serde?: SerializerProtocol;
  };

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
