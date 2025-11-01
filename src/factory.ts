/**
 * Factory for creating DynamoDB persistence instances with sensible defaults
 * Provides convenient methods for instantiating checkpointer, store, and chat history
 */

import type { DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import type { BedrockEmbeddings } from '@langchain/aws';
import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import { DynamoDBSaver } from './checkpointer';
import { DynamoDBStore } from './store';
import { DynamoDBChatMessageHistory } from './history';
import type { DynamoDBSaverOptions } from './checkpointer/types';
import type { DynamoDBStoreOptions } from './store/types';
import type { DynamoDBChatMessageHistoryOptions } from './history/types';

/**
 * Default table names with standard prefix
 */
const DEFAULT_TABLE_PREFIX = 'langgraph';

/**
 * Factory class for creating DynamoDB persistence instances
 */
export class DynamoDBFactory {
  /**
   * Create a DynamoDBSaver instance with sensible defaults
   *
   * @param options - Partial configuration options
   * @param options.checkpointsTableName - Optional checkpoints table name (default: 'langgraph-checkpoints')
   * @param options.writesTableName - Optional writes table name (default: 'langgraph-writes')
   * @param options.ttlDays - Optional TTL in days for automatic cleanup
   * @param options.serde - Optional custom serializer protocol
   * @param options.clientConfig - Optional DynamoDB client configuration
   * @returns Configured DynamoDBSaver instance
   *
   * @example
   * ```TypeScript
   * // Minimal configuration (uses defaults)
   * const checkpointer = DynamoDBFactory.createSaver({
   *   clientConfig: { region: 'us-east-1' }
   * });
   *
   * // Custom table names and TTL
   * const checkpointer = DynamoDBFactory.createSaver({
   *   checkpointsTableName: 'my-checkpoints',
   *   writesTableName: 'my-writes',
   *   ttlDays: 30,
   * });
   * ```
   */
  static createSaver(options: Partial<DynamoDBSaverOptions> = {}): DynamoDBSaver {
    const config: DynamoDBSaverOptions = {
      checkpointsTableName: options.checkpointsTableName ?? `${DEFAULT_TABLE_PREFIX}-checkpoints`,
      writesTableName: options.writesTableName ?? `${DEFAULT_TABLE_PREFIX}-writes`,
      ttlDays: options.ttlDays,
      serde: options.serde,
      clientConfig: options.clientConfig,
    };

    return new DynamoDBSaver(config);
  }

  /**
   * Create a DynamoDBStore instance with sensible defaults
   *
   * @param options - Partial configuration options
   * @param options.memoryTableName - Optional memory table name (default: 'langgraph-memory')
   * @param options.embedding - Optional Bedrock embeddings for semantic search
   * @param options.ttlDays - Optional TTL in days for automatic cleanup
   * @param options.clientConfig - Optional DynamoDB client configuration
   * @returns Configured DynamoDBStore instance
   *
   * @example
   * ```TypeScript
   * // Without a semantic search
   * const store = DynamoDBFactory.createStore({
   *   clientConfig: { region: 'us-east-1' }
   * });
   *
   * // With semantic search
   * import { BedrockEmbeddings } from '@langchain/aws';
   *
   * const store = DynamoDBFactory.createStore({
   *   embedding: new BedrockEmbeddings({
   *     model: 'amazon.titan-embed-text-v1',
   *   }),
   *   ttlDays: 90,
   * });
   * ```
   */
  static createStore(options: Partial<DynamoDBStoreOptions> = {}): DynamoDBStore {
    const config: DynamoDBStoreOptions = {
      memoryTableName: options.memoryTableName ?? `${DEFAULT_TABLE_PREFIX}-memory`,
      embedding: options.embedding,
      ttlDays: options.ttlDays,
      clientConfig: options.clientConfig,
    };

    return new DynamoDBStore(config);
  }

  /**
   * Create a DynamoDBChatMessageHistory instance with sensible defaults
   *
   * @param options - Partial configuration options
   * @param options.tableName - Optional chat history table name (default: 'langgraph-chat-history')
   * @param options.ttlDays - Optional TTL in days for automatic cleanup
   * @param options.clientConfig - Optional DynamoDB client configuration
   * @returns Configured DynamoDBChatMessageHistory instance
   *
   * @example
   * ```TypeScript
   * // Minimal configuration (uses defaults)
   * const history = DynamoDBFactory.createChatMessageHistory({
   *   clientConfig: { region: 'us-east-1' }
   * });
   *
   * // Custom table name and TTL
   * const history = DynamoDBFactory.createChatMessageHistory({
   *   tableName: 'my-chat-history',
   *   ttlDays: 365,
   * });
   * ```
   */
  static createChatMessageHistory(
    options: Partial<DynamoDBChatMessageHistoryOptions> = {},
  ): DynamoDBChatMessageHistory {
    const config: DynamoDBChatMessageHistoryOptions = {
      tableName: options.tableName ?? `${DEFAULT_TABLE_PREFIX}-chat-history`,
      ttlDays: options.ttlDays,
      clientConfig: options.clientConfig,
    };

    return new DynamoDBChatMessageHistory(config);
  }

  /**
   * Create all DynamoDB persistence instances at once with a shared configuration
   *
   * @param options - Configuration options
   * @param options.tablePrefix - Optional prefix for all table names (default: 'langgraph')
   * @param options.ttlDays - Optional TTL in days for automatic cleanup (applies to all)
   * @param options.clientConfig - Optional DynamoDB client configuration (shared)
   * @param options.embedding - Optional Bedrock embeddings for semantic search in store
   * @param options.serde - Optional custom serializer protocol for checkpointer
   * @returns Object containing all three persistence instances
   *
   * @example
   * ```TypeScript
   * // Create all instances with shared configuration
   * const { checkpointer, store, chatHistory } = DynamoDBFactory.createAll({
   *   tablePrefix: 'my-app',
   *   ttlDays: 30,
   *   clientConfig: { region: 'us-east-1' },
   * });
   *
   * // Use with LangGraph
   * const app = workflow.compile({
   *   checkpointer,
   *   store,
   * });
   * ```
   */
  static createAll(
    options: {
      tablePrefix?: string;
      ttlDays?: number;
      clientConfig?: DynamoDBClientConfig;
      embedding?: BedrockEmbeddings;
      serde?: SerializerProtocol;
    } = {},
  ): {
    checkpointer: DynamoDBSaver;
    store: DynamoDBStore;
    chatHistory: DynamoDBChatMessageHistory;
  } {
    const prefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX;

    return {
      checkpointer: this.createSaver({
        checkpointsTableName: `${prefix}-checkpoints`,
        writesTableName: `${prefix}-writes`,
        ttlDays: options.ttlDays,
        serde: options.serde,
        clientConfig: options.clientConfig,
      }),
      store: this.createStore({
        memoryTableName: `${prefix}-memory`,
        embedding: options.embedding,
        ttlDays: options.ttlDays,
        clientConfig: options.clientConfig,
      }),
      chatHistory: this.createChatMessageHistory({
        tableName: `${prefix}-chat-history`,
        ttlDays: options.ttlDays,
        clientConfig: options.clientConfig,
      }),
    };
  }
}
