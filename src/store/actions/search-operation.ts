import type { SearchItem } from '@langchain/langgraph-checkpoint';
import { SearchOperationActionParams } from '../types';
import { QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { BedrockEmbeddings } from '@langchain/aws';
import {
  validateNamespace,
  validateUserId,
  validatePagination,
  withDynamoDBRetry,
  buildFilterExpression,
  ValidationConstants,
} from '../utils';

/**
 * Search for memory items in DynamoDB
 *
 * @param params - Parameters for the search operation
 * @returns Array of matching items with optional similarity scores
 * @throws Error if the operation fails or validation fails
 */
export const searchOperationAction = async (
  params: SearchOperationActionParams,
): Promise<SearchItem[]> => {
  const { client, embedding, memoryTableName, userId, op } = params;

  const limit = op.limit ?? 100;
  const offset = op.offset ?? 0;

  // Validate inputs
  validateUserId(userId);
  // Allow empty namespace prefix to search all namespaces
  if (op.namespacePrefix.length > 0) {
    validateNamespace(op.namespacePrefix);
  }
  validatePagination(limit, offset);

  const namespacePrefix = op.namespacePrefix.join('/');

  const queryParams: QueryCommandInput = {
    TableName: memoryTableName,
  };

  // Build ExpressionAttributeValues and ExpressionAttributeNames
  const expressionAttributeValues: Record<string, any> = {
    ':uid': userId,
  };
  const expressionAttributeNames: Record<string, string> = {};

  // Build KeyConditionExpression
  let keyConditionExpression = 'user_id = :uid';

  if (namespacePrefix) {
    // Use begins_with on namespace_key for hierarchical search
    expressionAttributeValues[':nsp'] = `${namespacePrefix}#`;
    keyConditionExpression += ' AND begins_with(namespace_key, :nsp)';
  }

  queryParams.KeyConditionExpression = keyConditionExpression;
  queryParams.ExpressionAttributeValues = expressionAttributeValues;

  // Build filter expression if provided
  if (op.filter && Object.keys(op.filter).length > 0) {
    const filterResult = buildFilterExpression(
      op.filter,
      expressionAttributeNames,
      expressionAttributeValues,
    );

    if (filterResult.filterExpression) {
      queryParams.FilterExpression = filterResult.filterExpression;
      queryParams.ExpressionAttributeNames = expressionAttributeNames;
      queryParams.ExpressionAttributeValues = expressionAttributeValues;
    }
  }

  const items: any[] = [];
  let lastEvaluatedKey: Record<string, any> | undefined;
  let scannedCount = 0;
  let iterationCount = 0;

  // Execute a query with retry logic and safety limits
  do {
    // Prevent infinite loops
    iterationCount++;
    if (iterationCount > ValidationConstants.MAX_LOOP_ITERATIONS) {
      throw new Error('Search operation exceeded maximum iteration limit');
    }

    queryParams.Limit = Math.max(1, limit + offset - scannedCount);

    if (lastEvaluatedKey) {
      queryParams.ExclusiveStartKey = lastEvaluatedKey;
    }

    const response = await withDynamoDBRetry(async () => {
      return await client.query(queryParams);
    });

    scannedCount += response.ScannedCount ?? 0;

    if (response.Items && response.Items.length > 0) {
      // Prevent memory exhaustion
      if (items.length + response.Items.length > ValidationConstants.MAX_TOTAL_ITEMS_IN_MEMORY) {
        throw new Error('Search operation exceeded maximum items in memory limit');
      }
      items.push(...response.Items);
    }

    lastEvaluatedKey = response.LastEvaluatedKey;

    if (!lastEvaluatedKey) break;
    if (items.length >= limit + offset) break;
    if (scannedCount >= limit + offset) break;
  } while (
    // eslint-disable-next-line no-constant-condition
    true
  );

  if (items.length > 0) {
    let paginatedItems = items.slice(offset, offset + limit);
    if (op.query && embedding) {
      paginatedItems = await applySemanticSearch(paginatedItems, op.query, embedding);
    }
    return paginatedItems.map(
      (item): SearchItem => ({
        namespace: item.namespace.split('/'),
        key: item.key,
        value: item.value,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        score: item.score,
      }),
    );
  }

  return [];
};

/**
 * Apply semantic search using vector embeddings and cosine similarity
 * Falls back to returning original items if embedding generation fails
 */
async function applySemanticSearch(
  items: any[],
  query: string,
  embedding: BedrockEmbeddings,
): Promise<any[]> {
  try {
    const queryEmbedding = await embedding.embedQuery(query);

    const itemsWithScores = items
      .map((item) => {
        if (!item.embedding || !Array.isArray(item.embedding) || item.embedding.length === 0) {
          // Items without embeddings get score 0
          return { item: { ...item, score: 0 }, score: 0 };
        }

        // Calculate similarity for each embedding (multiple fields can be embedded)
        // Take the maximum similarity across all embeddings
        const similarities = item.embedding.map((emb: number[]) =>
          cosineSimilarity(queryEmbedding, emb),
        );
        const maxSimilarity = Math.max(...similarities);

        return {
          item: { ...item, score: maxSimilarity },
          score: maxSimilarity,
        };
      })
      .filter((result) => result.score > 0); // Only include items with embeddings

    // Sort by similarity score (highest first)
    itemsWithScores.sort((a, b) => b.score - a.score);
    return itemsWithScores.map((result) => result.item);
  } catch {
    // Fall back to returning original items if semantic search fails
    return items;
  }
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (!vecA || !vecB || vecA.length !== vecB.length || vecA.length === 0) {
    return 0;
  }

  const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
  const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
  const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));

  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }

  return dotProduct / (magnitudeA * magnitudeB);
}
