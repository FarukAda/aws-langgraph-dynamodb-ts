import jp from 'jsonpath';
import { PutOperationActionParams } from '../types';
import {
  validateNamespace,
  validateKey,
  validateValue,
  validateUserId,
  validateTTL,
  validateEmbeddings,
  validateJSONPath,
  withDynamoDBRetry,
} from '../utils';

/**
 * Put a memory item into DynamoDB
 *
 * @param params - Parameters for the put operation
 * @throws Error if the operation fails or validation fails
 */
export const putOperationAction = async (params: PutOperationActionParams): Promise<void> => {
  const { client, embedding, memoryTableName, userId, op, ttlDays } = params;

  // Validate inputs
  validateUserId(userId);
  validateNamespace(op.namespace);
  validateKey(op.key);
  validateValue(op.value);
  validateTTL(ttlDays);

  const namespacePath = op.namespace.join('/');
  const namespace_key = `${namespacePath}#${op.key}`;
  const now = Date.now();

  // Generate embeddings if requested
  let embeddings: number[][] | undefined;
  if (embedding && op.index && op.index.length > 0) {
    // Validate JSONPath expressions before use
    validateJSONPath(op.index);

    const textToEmbed: string[] = [];
    for (const path of op.index) {
      const value = jp.query(op.value, path);
      for (const v of value) {
        if (typeof v === 'string') {
          textToEmbed.push(v);
        } else if (typeof v === 'number' || typeof v === 'boolean') {
          textToEmbed.push(v.toString());
        } else if (v !== null && v !== undefined) {
          textToEmbed.push(JSON.stringify(v));
        }
      }
    }
    if (textToEmbed.length > 0) {
      embeddings = await embedding.embedDocuments(textToEmbed);
      validateEmbeddings(embeddings);
    }
  }

  // Build update expression
  const updateExpressionParts: string[] = [
    'namespace = :namespace',
    '#key = :key',
    '#value = :value',
    'updatedAt = :updatedAt',
  ];

  const expressionAttributeNames: Record<string, string> = {
    '#key': 'key',
    '#value': 'value',
  };

  const expressionAttributeValues: Record<string, any> = {
    ':namespace': namespacePath,
    ':key': op.key,
    ':value': op.value,
    ':updatedAt': now,
    ':createdAt': now,
  };

  // Add embedding if generated
  if (embeddings) {
    updateExpressionParts.push('embedding = :embedding');
    expressionAttributeValues[':embedding'] = embeddings;
  }

  // Add TTL if configured
  if (ttlDays && ttlDays > 0) {
    updateExpressionParts.push('ttl = :ttl');
    expressionAttributeValues[':ttl'] = Math.floor(Date.now() / 1000) + ttlDays * 24 * 60 * 60;
  }

  // Execute with retry logic
  await withDynamoDBRetry(async () => {
    await client.update({
      TableName: memoryTableName,
      Key: {
        user_id: userId,
        namespace_key: namespace_key,
      },
      UpdateExpression: `SET ${updateExpressionParts.join(', ')}, createdAt = if_not_exists(createdAt, :createdAt)`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    });
  });
};
