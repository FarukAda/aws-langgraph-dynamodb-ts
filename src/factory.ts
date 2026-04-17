/**
 * Factory for creating DynamoDB persistence instances with sensible defaults
 * Provides convenient methods for instantiating checkpointer, store, and chat history
 */

import { DynamoDBClient, type DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import { DynamoDBSaver } from './checkpointer';
import type { DynamoDBSaverOptions } from './checkpointer/types';
import { DynamoDBChatMessageHistory } from './history';
import type { DynamoDBChatMessageHistoryOptions } from './history/types';
import type { CompressionConfig, S3OffloadConfig } from './shared';
import { DynamoDBStore } from './store';
import type { DynamoDBStoreOptions } from './store/types';

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
      ttlSeconds: options.ttlSeconds,
      compression: options.compression,
      s3OffloadConfig: options.s3OffloadConfig,
      serde: options.serde,
      clientConfig: options.clientConfig,
      client: options.client,
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
      client: options.client,
      fallbackToLexicalOnEmbeddingFailure: options.fallbackToLexicalOnEmbeddingFailure,
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
      client: options.client,
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
      /** TTL in seconds for the saver (overrides ttlDays if both set). */
      ttlSeconds?: number;
      clientConfig?: DynamoDBClientConfig;
      embedding?: EmbeddingsInterface;
      serde?: SerializerProtocol;
      /** Compression configuration forwarded to the saver. */
      compression?: CompressionConfig;
      /** S3 offloading configuration forwarded to the saver. */
      s3OffloadConfig?: S3OffloadConfig;
      /**
       * Forwarded to the store — if true, semantic-search calls that hit an
       * embedding failure log a warning and return unranked results instead of
       * throwing. Defaults to false (fail-closed). See
       * {@link DynamoDBStoreOptions.fallbackToLexicalOnEmbeddingFailure}.
       */
      fallbackToLexicalOnEmbeddingFailure?: boolean;
    } = {},
  ): {
    checkpointer: DynamoDBSaver;
    store: DynamoDBStore;
    chatHistory: DynamoDBChatMessageHistory;
    /** Destroy the shared DynamoDB client created by createAll(). Call when no longer needed. */
    destroy: () => void;
  } {
    const prefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX;

    // Create a single shared DynamoDB client for all modules
    const ddbClient = new DynamoDBClient(options.clientConfig || {});
    const sharedClient = DynamoDBDocument.from(ddbClient);

    const checkpointer = this.createSaver({
      checkpointsTableName: `${prefix}-checkpoints`,
      writesTableName: `${prefix}-writes`,
      ttlDays: options.ttlDays,
      ttlSeconds: options.ttlSeconds,
      compression: options.compression,
      s3OffloadConfig: options.s3OffloadConfig,
      serde: options.serde,
      client: sharedClient,
    });
    const store = this.createStore({
      memoryTableName: `${prefix}-memory`,
      embedding: options.embedding,
      ttlDays: options.ttlDays,
      client: sharedClient,
      fallbackToLexicalOnEmbeddingFailure: options.fallbackToLexicalOnEmbeddingFailure,
    });
    const chatHistory = this.createChatMessageHistory({
      tableName: `${prefix}-chat-history`,
      ttlDays: options.ttlDays,
      client: sharedClient,
    });

    let destroyed = false;
    const destroy = (): void => {
      // Idempotency: SDK v3 tolerates double-destroy today, but the contract is
      // not part of the public v3 API — guard so a double-call (e.g. finally +
      // on-exit hook) can never error or re-enter the shutdown path.
      if (destroyed) return;
      destroyed = true;
      // Dispose module-local resources first (S3Offloader inside the saver) before
      // tearing down the shared DDB client. Each sub-instance skips DDB teardown
      // because it didn't own the shared client (ownsClient=false when injected).
      checkpointer.destroy();
      store.destroy();
      chatHistory.destroy();
      ddbClient.destroy();
    };

    return { checkpointer, store, chatHistory, destroy };
  }
}
