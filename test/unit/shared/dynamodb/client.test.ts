import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import { resolveDynamoDBClient } from '../../../../src/shared/dynamodb/client';

function createFakeClient(): DynamoDBClient {
  const middlewareStack = {
    add: jest.fn(),
    addRelativeTo: jest.fn(),
    use: jest.fn(),
    clone() {
      return middlewareStack;
    },
    concat() {
      return middlewareStack;
    },
  };
  return {
    destroy: jest.fn(),
    config: {},
    middlewareStack,
    send: jest.fn(),
  } as unknown as DynamoDBClient;
}

describe('resolveDynamoDBClient', () => {
  it('does not own an injected client', () => {
    const injected = DynamoDBDocument.from(new DynamoDBClient({ region: 'us-east-1' }));
    const resolved = resolveDynamoDBClient({ client: injected });
    expect(resolved.client).toBe(injected);
    expect(resolved.ownsClient).toBe(false);
    expect(resolved.ddbClient).toBeUndefined();
  });

  it('builds and owns a client via the factory seam', () => {
    const fakeClient = createFakeClient();
    const createClient = jest.fn().mockReturnValue(fakeClient);
    const resolved = resolveDynamoDBClient({
      clientConfig: { region: 'us-east-1' },
      createClient,
    });
    expect(createClient).toHaveBeenCalledWith({ region: 'us-east-1' });
    expect(resolved.ownsClient).toBe(true);
    expect(resolved.ddbClient).toBe(fakeClient);
  });

  it('defaults to an empty client config when none is provided', () => {
    const fakeClient = createFakeClient();
    const createClient = jest.fn().mockReturnValue(fakeClient);
    const resolved = resolveDynamoDBClient({ createClient });
    expect(createClient).toHaveBeenCalledWith({});
    expect(resolved.ownsClient).toBe(true);
  });

  it('builds a real DynamoDBClient through the default factory when no seam is given', () => {
    const resolved = resolveDynamoDBClient({ clientConfig: { region: 'us-east-1' } });
    expect(resolved.ownsClient).toBe(true);
    expect(resolved.ddbClient).toBeDefined();
    expect(resolved.client).toBeDefined();
    resolved.ddbClient?.destroy();
  });
});
