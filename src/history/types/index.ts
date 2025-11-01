/**
 * Type definitions for chat message history
 */

import { DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { BaseMessage } from '@langchain/core/messages';

/**
 * Configuration options for DynamoDBChatMessageHistory
 */
export interface DynamoDBChatMessageHistoryOptions {
  /** Name of the DynamoDB table to use for storage */
  tableName: string;
  /** Optional TTL in days for stored items (1-1825 days) */
  ttlDays?: number;
  /** Optional DynamoDB client configuration */
  clientConfig?: DynamoDBClientConfig;
}

/**
 * DynamoDB item structure for a chat session
 */
export interface DynamoDBSessionItem {
  /** User identifier (partition key) */
  userId: string;
  /** Session identifier (sort key) */
  sessionId: string;
  /** Array of messages in chronological order */
  messages: BaseMessage[];
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
}
