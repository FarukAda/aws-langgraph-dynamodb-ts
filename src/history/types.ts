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

/** The single DynamoDB item holding a session's full message history. */
export interface ChatSessionItem {
  PK: string;
  SK: string;
  sessionId: string;
  messages: PayloadDescriptor;
  messageCount: number;
  version: number;
  title?: string;
  createdAt: string;
  updatedAt: string;
  ttl?: number;
}
