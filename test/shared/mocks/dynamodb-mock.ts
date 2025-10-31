import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Create a mocked DynamoDB Document client
 * Uses aws-sdk-client-mock to mock DynamoDB operations
 */
export function createMockDynamoDBClient() {
  // Mock the DynamoDB Document client (this intercepts Document API calls)
  const ddbDocMock = mockClient(DynamoDBDocumentClient);

  // Reset the mock to ensure a clean state
  ddbDocMock.reset();

  // Create a document client instance
  const docClient = DynamoDBDocument.from(new DynamoDBClient({}));

  return { ddbDocMock, client: docClient };
}

/**
 * Setup mock for multiple sequential responses (for pagination tests)
 */
export function mockDynamoDBQueryPaginated(
  ddbMock: any,
  responses: Array<{ items: any[]; lastKey?: any }>,
) {
  let callCount = 0;
  ddbMock.onAnyCommand().callsFake(() => {
    const response = responses[callCount] || responses[responses.length - 1];
    callCount++;
    return Promise.resolve({
      Items: response.items,
      Count: response.items.length,
      ScannedCount: response.items.length,
      LastEvaluatedKey: response.lastKey,
    });
  });
}
