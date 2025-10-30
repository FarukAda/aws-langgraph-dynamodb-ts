import {
  BaseStore,
  type GetOperation,
  type PutOperation,
  type SearchOperation,
  type ListNamespacesOperation,
  type Item,
  type Operation,
  type OperationResults,
} from '@langchain/langgraph';
import type { SearchItem } from '@langchain/langgraph-checkpoint';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { BedrockEmbeddings } from '@langchain/aws';
import type { DynamoDBStoreOptions } from './types';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import {
  getOperationAction,
  putOperationAction,
  searchOperationAction,
  listNamespacesOperationAction,
} from './actions';
import { validateBatchSize } from './utils';

/**
 * DynamoDB-based store implementation for LangGraph
 * Provides persistent storage for memory items with optional semantic search via embeddings
 */
export class DynamoDBStore extends BaseStore {
  private readonly ddbClient: DynamoDBClient;
  private readonly client: DynamoDBDocument;
  private readonly memoryTableName: string;
  private readonly embedding?: BedrockEmbeddings;
  private readonly ttlDays?: number;

  /**
   * Create a new DynamoDB store instance
   *
   * @param options - Configuration options for the store
   * @param options.memoryTableName - Name of the DynamoDB table to use
   * @param options.embedding - Optional Bedrock embeddings for semantic search
   * @param options.clientConfig - Optional DynamoDB client configuration
   * @param options.ttlDays - Optional TTL in days for stored items
   */
  constructor(options: DynamoDBStoreOptions) {
    super();
    this.memoryTableName = options.memoryTableName;
    this.ddbClient = new DynamoDBClient(options.clientConfig || {});
    this.client = DynamoDBDocument.from(this.ddbClient);
    this.embedding = options.embedding;
    this.ttlDays = options.ttlDays;
  }

  /**
   * Extract and validate user ID from config
   *
   * @param config - Runnable configuration
   * @returns User ID string
   * @throws Error if user_id is not provided or invalid
   */
  private getUserId(config?: RunnableConfig): string {
    const userId = config?.configurable?.user_id;
    if (!userId || typeof userId !== 'string') {
      throw new Error('Field user_id is required in the RunnableConfig for DynamoDBStore.');
    }
    return userId;
  }

  /**
   * Execute a batch of operations in parallel
   *
   * @param operations - Array of operations to execute
   * @param config - Runnable configuration containing user_id
   * @returns Array of results corresponding to each operation
   * @throws Error if user_id is not provided in config or if any operation fails
   */
  async batch<Op extends Operation[]>(
    operations: Op,
    config?: RunnableConfig,
  ): Promise<OperationResults<Op>> {
    const userId = this.getUserId(config);

    // Validate batch size to prevent resource exhaustion
    validateBatchSize(operations.length);

    // Execute all operations in parallel for better performance
    const promises = operations.map(async (op, index) => {
      if ('key' in op && !('value' in op)) {
        return await this.getOperation(userId, op as GetOperation);
      }
      if ('key' in op && 'value' in op) {
        return await this.putOperation(userId, op as PutOperation);
      }
      if ('namespacePrefix' in op) {
        return await this.searchOperation(userId, op as SearchOperation);
      }
      if (!('namespacePrefix' in op) && 'limit' in op && 'offset' in op) {
        return await this.listNamespacesOperation(userId, op as ListNamespacesOperation);
      }

      // Unrecognized operation - sanitized error message to prevent information disclosure
      throw new Error(`Unrecognized operation type at index ${index}`);
    });

    return (await Promise.all(promises)) as OperationResults<Op>;
  }

  /**
   * Get a single item from the store
   *
   * @param userId - User ID for the item
   * @param op - Get operation parameters
   * @returns The item if found, null otherwise
   */
  private async getOperation(userId: string, op: GetOperation): Promise<Item | null> {
    return await getOperationAction({
      client: this.client,
      memoryTableName: this.memoryTableName,
      userId,
      op,
    });
  }

  /**
   * Put an item into the store
   *
   * @param userId - User ID for the item
   * @param op - Put operation parameters
   */
  private async putOperation(userId: string, op: PutOperation): Promise<void> {
    await putOperationAction({
      client: this.client,
      memoryTableName: this.memoryTableName,
      userId,
      op,
      embedding: this.embedding,
      ttlDays: this.ttlDays,
    });
  }

  /**
   * Search for items in the store with optional semantic search
   *
   * @param userId - User ID for filtering items
   * @param op - Search operation parameters
   * @returns Array of matching items with optional similarity scores
   */
  private async searchOperation(userId: string, op: SearchOperation): Promise<SearchItem[]> {
    return await searchOperationAction({
      client: this.client,
      memoryTableName: this.memoryTableName,
      userId,
      op,
      embedding: this.embedding,
    });
  }

  /**
   * List unique namespaces in the store
   *
   * @param userId - User ID for filtering namespaces
   * @param op - List namespaces operation parameters
   * @returns Array of namespace paths
   */
  private async listNamespacesOperation(
    userId: string,
    op: ListNamespacesOperation,
  ): Promise<string[][]> {
    return await listNamespacesOperationAction({
      client: this.client,
      memoryTableName: this.memoryTableName,
      userId,
      op,
    });
  }
}
