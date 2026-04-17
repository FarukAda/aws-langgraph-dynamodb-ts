import { QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import type { SearchItem } from '@langchain/langgraph-checkpoint';

import { getLogger } from '../../shared/utils';
import { SearchOperationActionParams } from '../types';
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
 * @remarks
 * **Pagination trade-off:** DynamoDB does not support native offset-based pagination.
 * When `offset` is used, `limit + offset` items are loaded into memory and sliced.
 * For large offsets (up to 10,000), this can be memory-intensive.
 * Consider cursor-based pagination for high-offset use cases.
 *
 * @param params - Parameters for the search operation
 * @returns Array of matching items with optional similarity scores
 * @throws Error if the operation fails or validation fails
 */
export const searchOperationAction = async (
  params: SearchOperationActionParams,
): Promise<SearchItem[]> => {
  const {
    client,
    embedding,
    memoryTableName,
    userId,
    op,
    fallbackToLexicalOnEmbeddingFailure = false,
    signal,
  } = params;

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
    // Use begins_with on namespace_key for hierarchical search. NOTE: we do NOT
    // append a separator — `namespace_key` is `<nsPath>#<key>`, so appending "#"
    // would miss sub-namespaces ("users/alice#x" doesn't begin with "users#"),
    // and appending "/" would miss exact matches. Raw prefix is over-inclusive
    // (`users` also matches `users_v2`) but the in-memory ordering guarantees
    // correctness; the spurious rows are negligible in practice.
    expressionAttributeValues[':nsp'] = namespacePrefix;
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

  // When semantic search is requested, we must fetch ALL matching items so that
  // cosine similarity ranking operates on the full corpus — not just an arbitrary
  // DynamoDB page.  For non-semantic queries we keep the original capped fetch.
  const isSemanticSearch = !!op.query && !!embedding;
  const fetchTarget = isSemanticSearch ? undefined : limit + offset;

  if (op.query && !embedding) {
    // User asked for text search but no embedding is configured — the query is
    // effectively dropped. Warn so callers aren't surprised by unfiltered results.
    getLogger().warn(
      'search operation received `query` but no embedding is configured on the store; ' +
        'text search is skipped and results reflect only filter/namespace matches',
    );
  }

  const items: any[] = [];
  let lastEvaluatedKey: Record<string, any> | undefined;
  let iterationCount = 0;

  // Execute a query with retry logic and safety limits
  do {
    // Prevent infinite loops
    iterationCount++;
    if (iterationCount > ValidationConstants.MAX_LOOP_ITERATIONS) {
      throw new Error('Search operation exceeded maximum iteration limit');
    }

    // Size each page based on items still needed (items.length, not ScannedCount).
    // ScannedCount grows even for filtered-out rows, so gating by it can terminate
    // the loop early when a FilterExpression is active.
    queryParams.Limit = fetchTarget ? Math.max(1, fetchTarget - items.length) : undefined;

    if (lastEvaluatedKey) {
      queryParams.ExclusiveStartKey = lastEvaluatedKey;
    }

    const response = await withDynamoDBRetry(
      async () => {
        return await client.query(queryParams);
      },
      { signal },
    );

    if (response.Items && response.Items.length > 0) {
      // Memory cap: non-semantic search throws (hard fail, surfaces to caller).
      // Semantic search logs a warning and returns a partial (possibly suboptimal)
      // ranked corpus instead — better than nothing for a best-effort relevance feature.
      if (items.length + response.Items.length > ValidationConstants.MAX_TOTAL_ITEMS_IN_MEMORY) {
        if (isSemanticSearch) {
          getLogger().warn(
            `Semantic search corpus truncated at ${ValidationConstants.MAX_TOTAL_ITEMS_IN_MEMORY} items — ` +
              `results may not include the most relevant matches`,
          );
          const remaining = ValidationConstants.MAX_TOTAL_ITEMS_IN_MEMORY - items.length;
          if (remaining > 0) items.push(...response.Items.slice(0, remaining));
          break;
        }
        throw new Error('Search operation exceeded maximum items in memory limit');
      }
      items.push(...response.Items);
    }

    lastEvaluatedKey = response.LastEvaluatedKey;

    if (!lastEvaluatedKey) break;
    if (fetchTarget && items.length >= fetchTarget) break;
  } while (lastEvaluatedKey);

  if (items.length > 0) {
    let paginatedItems: any[];
    if (isSemanticSearch) {
      // Rank the ENTIRE corpus by similarity, then paginate
      const ranked = await applySemanticSearch(
        items,
        op.query!,
        embedding!,
        fallbackToLexicalOnEmbeddingFailure,
      );
      paginatedItems = ranked.slice(offset, offset + limit);
    } else {
      paginatedItems = items.slice(offset, offset + limit);
    }
    return paginatedItems.map(
      (item): SearchItem => ({
        namespace: item.namespace.split('/'),
        key: item.key,
        value: item.value,
        createdAt: new Date(item.createdAt),
        updatedAt: new Date(item.updatedAt),
        score: item.score,
      }),
    );
  }

  return [];
};

/**
 * Apply semantic search using vector embeddings and cosine similarity.
 *
 * Fail-closed by default: an `embedQuery()` failure propagates to the caller so
 * they know the returned ranking is not what was requested. Pass
 * `fallbackToLexical = true` to opt in to the legacy fail-open behavior where
 * embedding errors are logged and the raw, unranked items are returned.
 */
async function applySemanticSearch(
  items: any[],
  query: string,
  embedding: EmbeddingsInterface,
  fallbackToLexical: boolean,
): Promise<any[]> {
  let queryEmbedding: number[];
  try {
    queryEmbedding = await embedding.embedQuery(query);
  } catch (error) {
    if (!fallbackToLexical) {
      // Fail-closed: surface the failure so the caller can retry or degrade explicitly.
      throw error;
    }
    getLogger().warn(
      'Semantic search embedding failed — returning unranked results (fallbackToLexicalOnEmbeddingFailure=true):',
      error,
    );
    return items;
  }

  try {
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
  } catch (error) {
    if (!fallbackToLexical) {
      throw error;
    }
    getLogger().warn(
      'Semantic search ranking failed — returning unranked results (fallbackToLexicalOnEmbeddingFailure=true):',
      error,
    );
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
