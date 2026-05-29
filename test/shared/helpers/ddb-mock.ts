import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

/**
 * Build a `DynamoDBDocument` whose every command rejects unless explicitly
 * stubbed via the returned `mock`. Forces tests to assert the exact command +
 * input rather than letting unexpected calls silently resolve `undefined`.
 */
export function createStrictDocumentMock(): {
  client: DynamoDBDocument;
  mock: ReturnType<typeof mockClient>;
} {
  const client = DynamoDBDocument.from(new DynamoDBClient({ region: 'us-east-1' }));
  const mock = mockClient(client);
  mock.rejects(new Error('unstubbed command'));
  return { client, mock };
}
