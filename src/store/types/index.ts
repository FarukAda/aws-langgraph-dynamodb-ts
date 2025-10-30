import { BedrockEmbeddings } from '@langchain/aws';
import { DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import {
  GetOperation,
  type ListNamespacesOperation,
  type PutOperation,
  type SearchOperation,
} from '@langchain/langgraph';

/**
 * Namespace path - array of strings with optional wildcards
 */
export type NamespacePath = (string | '*')[];

/**
 * Configuration options for DynamoDBStore
 */
export interface DynamoDBStoreOptions {
  /** Name of the DynamoDB table to use for storage */
  memoryTableName: string;
  /** Optional Bedrock embeddings for semantic search */
  embedding?: BedrockEmbeddings;
  /** Optional DynamoDB client configuration */
  clientConfig?: DynamoDBClientConfig;
  /** Optional TTL in days for stored items (1-1825 days) */
  ttlDays?: number;
}

/**
 * Parameters for put operation action
 */
export interface PutOperationActionParams {
  /** DynamoDB document client */
  client: DynamoDBDocument;
  /** Name of the memory table */
  memoryTableName: string;
  /** User ID for the operation */
  userId: string;
  /** Put operation parameters */
  op: PutOperation;
  /** Optional embeddings for semantic search */
  embedding?: BedrockEmbeddings;
  /** Optional TTL in days */
  ttlDays?: number;
}

/**
 * Parameters for get operation action
 */
export interface GetOperationActionParams {
  /** DynamoDB document client */
  client: DynamoDBDocument;
  /** Name of the memory table */
  memoryTableName: string;
  /** User ID for the operation */
  userId: string;
  /** Get operation parameters */
  op: GetOperation;
}

/**
 * Parameters for search operation action
 */
export interface SearchOperationActionParams {
  /** DynamoDB document client */
  client: DynamoDBDocument;
  /** Name of the memory table */
  memoryTableName: string;
  /** User ID for the operation */
  userId: string;
  /** Search operation parameters */
  op: SearchOperation;
  /** Optional embeddings for semantic search */
  embedding?: BedrockEmbeddings;
}

/**
 * Parameters for list namespaces operation action
 */
export interface ListNamespacesOperationActionParams {
  /** DynamoDB document client */
  client: DynamoDBDocument;
  /** Name of the memory table */
  memoryTableName: string;
  /** User ID for the operation */
  userId: string;
  /** List namespaces operation parameters */
  op: ListNamespacesOperation;
}

/**
 * Filter value with comparison operators
 */
export type FilterValue = {
  /** Equal to */
  $eq?: any;
  /** Not equal to */
  $ne?: any;
  /** Greater than */
  $gt?: number;
  /** Greater than or equal to */
  $gte?: number;
  /** Less than */
  $lt?: number;
  /** Less than or equal to */
  $lte?: number;
};
