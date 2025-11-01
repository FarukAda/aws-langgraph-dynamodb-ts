/**
 * Clear all messages in a session
 */

import type { ClearActionParams } from '../types';
import { validateUserId, validateSessionId, withDynamoDBRetry } from '../utils';

/**
 * Clear all messages in a session by deleting the session item
 * No error is thrown if the session doesn't exist
 *
 * @param params - Parameters for the clear operation
 * @throws Error if the operation fails or validation fails
 */
export const clearAction = async (params: ClearActionParams): Promise<void> => {
  const { client, tableName, userId, sessionId } = params;

  // Validate inputs
  validateUserId(userId);
  validateSessionId(sessionId);

  // Execute delete with retry logic
  await withDynamoDBRetry(async () => {
    await client.delete({
      TableName: tableName,
      Key: {
        userId,
        sessionId,
      },
    });
  });
};
