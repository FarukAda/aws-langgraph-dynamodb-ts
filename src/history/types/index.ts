/**
 * Type definitions for chat message history
 * Uses per-message storage pattern: each message is a separate DynamoDB item
 */

import { DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import type { BaseMessage, StoredMessage } from '@langchain/core/messages';

/**
 * Configuration options for DynamoDBChatMessageHistory
 *
 * @remarks
 * **TTL semantics — important:**
 *
 * - The **session metadata** item's `ttl` attribute is refreshed on every
 *   `addMessage` / `addMessages` call, so `listSessions()` reflects a session as
 *   live as long as new messages keep arriving within `ttlDays`.
 * - Individual **message items** get a TTL stamped at write time and each
 *   expires independently. A long-lived session that ingests new messages every
 *   few days can develop gaps where old messages expire while newer ones
 *   persist.
 *
 * If you need a strict "keep the whole conversation as long as it is active"
 * contract, set `ttlDays` significantly larger than your expected session
 * lifetime, or manage deletion yourself via `clear()`.
 */
export interface DynamoDBChatMessageHistoryOptions {
  /** Name of the DynamoDB table to use for storage */
  tableName: string;
  /**
   * Optional TTL in days for stored items (1-1825 days).
   *
   * Metadata TTL is sliding (refreshed on every write). Per-message TTL is
   * fixed at each message's write time — see the class-level remarks for
   * implications on long-lived sessions.
   */
  ttlDays?: number;
  /** Optional DynamoDB client configuration */
  clientConfig?: DynamoDBClientConfig;
  /** Optional pre-built DynamoDBDocument client (takes precedence over clientConfig) */
  client?: DynamoDBDocument;
}

/**
 * DynamoDB item for session metadata
 * PK: userId, SK: sessionId
 */
export interface DynamoDBSessionMetadataItem {
  /** User identifier (partition key) */
  userId: string;
  /** Session identifier (sort key) */
  sessionId: string;
  /** Item type discriminator */
  itemType: 'metadata';
  /** Session title (auto-generated from the first message) */
  title: string;
  /** Timestamp when session was created (milliseconds) */
  createdAt: number;
  /** Timestamp when the session was last updated (milliseconds) */
  updatedAt: number;
  /** Number of messages in the session */
  messageCount: number;
  /** Optional TTL timestamp (Unix timestamp in seconds) */
  ttl?: number;
}

/**
 * DynamoDB item for an individual message
 * PK: userId, SK: sessionId#msg#NNNNNN
 */
export interface DynamoDBMessageItem {
  /** User identifier (partition key) */
  userId: string;
  /** Composite sort key: sessionId#msg#NNNNNN */
  sessionId: string;
  /** Item type discriminator */
  itemType: 'message';
  /** Zero-based message index */
  messageIndex: number;
  /** Serialized message in LangChain StoredMessage format */
  message: StoredMessage;
  /** Optional TTL timestamp (Unix timestamp in seconds) */
  ttl?: number;
}

/**
 * Session metadata for listing (excludes messages)
 */
export interface SessionMetadata {
  /** Session identifier */
  sessionId: string;
  /** Session title */
  title: string;
  /** Timestamp when session was created (milliseconds) */
  createdAt: number;
  /** Timestamp when the session was last updated (milliseconds) */
  updatedAt: number;
  /** Number of messages in the session */
  messageCount: number;
}

/**
 * Parameters for get message action
 */
export interface GetMessagesActionParams {
  /** DynamoDB document client */
  client: DynamoDBDocument;
  /** Name of the table */
  tableName: string;
  /** User identifier */
  userId: string;
  /** Session identifier */
  sessionId: string;
  /** Optional AbortSignal — cancels in-flight retries */
  signal?: AbortSignal;
}

/**
 * Parameters for add message action
 */
export interface AddMessageActionParams {
  /** DynamoDB document client */
  client: DynamoDBDocument;
  /** Name of the table */
  tableName: string;
  /** User identifier */
  userId: string;
  /** Session identifier */
  sessionId: string;
  /** Message to add */
  message: BaseMessage;
  /** Optional session title (auto-generated if not provided) */
  title?: string;
  /** Optional TTL in days */
  ttlDays?: number;
  /** Optional AbortSignal — cancels in-flight retries */
  signal?: AbortSignal;
}

/**
 * Parameters for add messages action
 */
export interface AddMessagesActionParams {
  /** DynamoDB document client */
  client: DynamoDBDocument;
  /** Name of the table */
  tableName: string;
  /** User identifier */
  userId: string;
  /** Session identifier */
  sessionId: string;
  /** Messages to add */
  messages: BaseMessage[];
  /** Optional session title (auto-generated if not provided) */
  title?: string;
  /** Optional TTL in days */
  ttlDays?: number;
  /** Optional AbortSignal — cancels in-flight retries */
  signal?: AbortSignal;
}

/**
 * Parameters for clear action
 */
export interface ClearActionParams {
  /** DynamoDB document client */
  client: DynamoDBDocument;
  /** Name of the table */
  tableName: string;
  /** User identifier */
  userId: string;
  /** Session identifier */
  sessionId: string;
  /** Optional AbortSignal — cancels in-flight retries */
  signal?: AbortSignal;
}

/**
 * Parameters for list sessions action
 */
export interface ListSessionsActionParams {
  /** DynamoDB document client */
  client: DynamoDBDocument;
  /** Name of the table */
  tableName: string;
  /** User identifier */
  userId: string;
  /** Optional maximum number of sessions to return */
  limit?: number;
  /** Optional AbortSignal — cancels in-flight retries */
  signal?: AbortSignal;
}
