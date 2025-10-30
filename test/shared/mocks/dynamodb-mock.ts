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

  // Reset the mock to ensure clean state
  ddbDocMock.reset();

  // Create a document client instance
  const docClient = DynamoDBDocument.from(new DynamoDBClient({}));

  return { ddbDocMock, client: docClient };
}

/**
 * Reset all mocks to clean state
 */
export function resetDynamoDBMock(ddbMock: any) {
  ddbMock.reset();
}

/**
 * Setup mock for successful get operation
 */
export function mockDynamoDBGet(ddbMock: any, item: any) {
  ddbMock.onAnyCommand().resolves({ Item: item });
}

/**
 * Setup mock for get operation returning no item
 */
export function mockDynamoDBGetEmpty(ddbMock: any) {
  ddbMock.onAnyCommand().resolves({});
}

/**
 * Setup mock for successful put operation
 */
export function mockDynamoDBPut(ddbMock: any) {
  ddbMock.onAnyCommand().resolves({});
}

/**
 * Setup mock for successful query operation
 */
export function mockDynamoDBQuery(ddbMock: any, items: any[], lastEvaluatedKey?: any) {
  ddbMock.onAnyCommand().resolves({
    Items: items,
    Count: items.length,
    ScannedCount: items.length,
    LastEvaluatedKey: lastEvaluatedKey,
  });
}

/**
 * Setup mock for successful batchWrite operation
 */
export function mockDynamoDBBatchWrite(ddbMock: any) {
  ddbMock.onAnyCommand().resolves({});
}

/**
 * Setup mock for a successful update operation
 */
export function mockDynamoDBUpdate(ddbMock: any) {
  ddbMock.onAnyCommand().resolves({});
}

/**
 * Setup mock for DynamoDB error
 */
export function mockDynamoDBError(ddbMock: any, errorName: string, errorMessage: string) {
  const error = new Error(errorMessage);
  error.name = errorName;
  ddbMock.onAnyCommand().rejects(error);
}

/**
 * Setup mock for retryable DynamoDB error
 */
export function mockDynamoDBRetryableError(
  ddbMock: any,
  errorName: 'ProvisionedThroughputExceededException' | 'ThrottlingException',
) {
  const error = new Error('Retryable error');
  error.name = errorName;
  ddbMock.onAnyCommand().rejects(error);
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
