import type { MatchCondition } from '@langchain/langgraph-checkpoint';
import type { QueryCommandInput } from '@aws-sdk/lib-dynamodb';

import type { ListNamespacesOperationActionParams, NamespacePath } from '../types';
import {
  validateUserId,
  validatePagination,
  validateMaxDepth,
  withDynamoDBRetry,
  ValidationConstants,
} from '../utils';

/**
 * List unique namespaces from DynamoDB with filtering and pagination
 *
 * @param params - Parameters for the list namespaces operation
 * @returns Array of namespace paths (each path is an array of strings including userId)
 * @throws Error if the operation fails or validation fails
 */
export const listNamespacesOperationAction = async (
  params: ListNamespacesOperationActionParams,
): Promise<string[][]> => {
  const { client, memoryTableName, userId, op } = params;

  const limit = op.limit;
  const offset = op.offset;
  const matchConditions = op.matchConditions ?? [];
  const maxDepth = op.maxDepth;

  // Validate inputs
  validateUserId(userId);
  validatePagination(limit, offset);
  validateMaxDepth(maxDepth);

  // Determine if we can optimize with KeyConditionExpression
  const prefixCondition = matchConditions.find((c) => c.matchType === 'prefix');
  const namespacePrefix = prefixCondition ? extractConcretePrefix(prefixCondition.path) : '';

  // Build query parameters
  const queryParams: QueryCommandInput = {
    TableName: memoryTableName,
    KeyConditionExpression: 'user_id = :uid',
    ExpressionAttributeValues: {
      ':uid': userId,
    },
    ExpressionAttributeNames: {},
    ProjectionExpression: 'namespace',
  };

  // Optimize a query with begins_with for prefix conditions
  if (namespacePrefix) {
    queryParams.KeyConditionExpression += ' AND begins_with(namespace_key, :nsPrefix)';
    queryParams.ExpressionAttributeValues![':nsPrefix'] = `${namespacePrefix}#`;
  }

  // Build FilterExpression for suffix conditions using contains()
  const filterExpressions: string[] = [];
  const suffixConditions = matchConditions.filter((c) => c.matchType === 'suffix');

  suffixConditions.forEach((condition, index) => {
    const concreteSuffix = extractConcreteSuffix(condition.path);
    if (concreteSuffix) {
      const attrName = `#ns${index}`;
      const valueName = `:suffix${index}`;
      queryParams.ExpressionAttributeNames![attrName] = 'namespace';
      queryParams.ExpressionAttributeValues![valueName] = concreteSuffix;
      filterExpressions.push(`contains(${attrName}, ${valueName})`);
    }
  });

  if (filterExpressions.length > 0) {
    queryParams.FilterExpression = filterExpressions.join(' AND ');
  }

  // Use a Set to track unique namespaces
  const namespaceSet = new Set<string>();
  let lastEvaluatedKey: Record<string, any> | undefined;
  let iterationCount = 0;

  // Fetch all matching items with retry logic and safety limits
  const CANDIDATE_MULTIPLIER = 10; // Fetch 10x more candidates to account for filtering
  // Cap the target size to prevent excessive memory usage
  const targetSize = Math.min(
    (limit + offset) * CANDIDATE_MULTIPLIER,
    ValidationConstants.MAX_TOTAL_ITEMS_IN_MEMORY,
  );

  do {
    // Prevent infinite loops
    iterationCount++;
    if (iterationCount > ValidationConstants.MAX_LOOP_ITERATIONS) {
      throw new Error('List namespaces operation exceeded maximum iteration limit');
    }

    if (lastEvaluatedKey) {
      queryParams.ExclusiveStartKey = lastEvaluatedKey;
    }

    const response = await withDynamoDBRetry(async () => {
      return await client.query(queryParams);
    });

    // Extract and deduplicate namespaces
    response.Items?.forEach((item) => {
      if (item.namespace !== undefined && item.namespace !== null) {
        // Prevent memory exhaustion
        if (namespaceSet.size >= ValidationConstants.MAX_TOTAL_ITEMS_IN_MEMORY) {
          return; // Stop adding more items
        }
        namespaceSet.add(item.namespace);
      }
    });

    lastEvaluatedKey = response.LastEvaluatedKey;

    // Stop after collecting enough candidates
    if (namespaceSet.size >= targetSize) {
      break;
    }
  } while (lastEvaluatedKey);

  // Convert Set to an array of namespace arrays (include userId)
  const allNamespaces = Array.from(namespaceSet).map((ns) => {
    const parts = ns ? ns.split('/') : [];
    return [userId, ...parts];
  });

  // Apply all match conditions
  const filteredNamespaces = allNamespaces.filter((namespacePath) => {
    // Check all match conditions (must match ALL)
    for (const condition of matchConditions) {
      // Always check the condition, regardless of wildcards
      // DynamoDB filtering is just an optimization, we verify all conditions here
      if (!matchesCondition(namespacePath, condition)) {
        return false;
      }
    }

    // Check maxDepth if specified
    if (maxDepth !== undefined) {
      // Depth is measured from userId (first element)
      const depth = namespacePath.length;
      if (depth > maxDepth) {
        return false;
      }
    }

    return true;
  });

  // Sort namespaces for consistent ordering
  filteredNamespaces.sort((a, b) => a.join('/').localeCompare(b.join('/')));

  // Apply offset and limit
  return filteredNamespaces.slice(offset, offset + limit);
};

/**
 * Extract a concrete prefix (before any wildcards) from a path for DynamoDB optimization
 */
function extractConcretePrefix(path: NamespacePath): string {
  const concreteParts: string[] = [];

  for (let i = 0; i < path.length; i++) {
    if (path[i] === '*') {
      break;
    }
    concreteParts.push(path[i] as string);
  }

  return concreteParts.join('/');
}

/**
 * Extract concrete suffix (after any wildcards) from a path for DynamoDB contains()
 * Returns the suffix pattern for contains() matching
 */
function extractConcreteSuffix(path: NamespacePath): string {
  const concreteParts: string[] = [];

  // Collect concrete parts from the end, working backwards until we hit a wildcard
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i] === '*') {
      break;
    }
    concreteParts.unshift(path[i] as string);
  }

  // Return as a path string (e.g., "reports/2024")
  return concreteParts.join('/');
}

/**
 * Check if a namespace matches a single condition
 */
function matchesCondition(namespacePath: string[], condition: MatchCondition): boolean {
  const { matchType, path } = condition;

  if (matchType === 'prefix') {
    return matchesPrefix(namespacePath, path);
  } else if (matchType === 'suffix') {
    return matchesSuffix(namespacePath, path);
  }

  return false;
}

/**
 * Check if a namespace matches a prefix pattern (supports wildcards)
 */
function matchesPrefix(namespacePath: string[], pattern: NamespacePath): boolean {
  // Pattern must not be longer than the namespace
  if (pattern.length > namespacePath.length) {
    return false;
  }

  // Check each position in the pattern
  for (let i = 0; i < pattern.length; i++) {
    const patternPart = pattern[i];
    const namespacePart = namespacePath[i];

    // Wildcard matches anything
    if (patternPart === '*') {
      continue;
    }

    // Concrete value must match exactly
    if (patternPart !== namespacePart) {
      return false;
    }
  }

  return true;
}

/**
 * Check if a namespace matches a suffix pattern (supports wildcards)
 */
function matchesSuffix(namespacePath: string[], pattern: NamespacePath): boolean {
  // Pattern must not be longer than the namespace
  if (pattern.length > namespacePath.length) {
    return false;
  }

  // Check from the end
  const offset = namespacePath.length - pattern.length;
  for (let i = 0; i < pattern.length; i++) {
    const patternPart = pattern[i];
    const namespacePart = namespacePath[offset + i];

    // Wildcard matches anything
    if (patternPart === '*') {
      continue;
    }

    // Concrete value must match exactly
    if (patternPart !== namespacePart) {
      return false;
    }
  }

  return true;
}
