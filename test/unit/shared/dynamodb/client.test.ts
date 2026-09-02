import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import {
  resolveDynamoDBClient,
  warnOnStackedRetries,
} from '../../../../src/shared/dynamodb/client';

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
    expect(createClient).toHaveBeenCalledWith({ maxAttempts: 1, region: 'us-east-1' });
    expect(resolved.ownsClient).toBe(true);
    expect(resolved.ddbClient).toBe(fakeClient);
  });

  it('defaults to a single SDK attempt (own retry layer owns retries) when no client config is provided', () => {
    const fakeClient = createFakeClient();
    const createClient = jest.fn().mockReturnValue(fakeClient);
    const resolved = resolveDynamoDBClient({ createClient });
    expect(createClient).toHaveBeenCalledWith({ maxAttempts: 1 });
    expect(resolved.ownsClient).toBe(true);
  });

  it("disables the SDK's own internal retries by default, so this library's retry layer is the sole source of truth", () => {
    const fakeClient = createFakeClient();
    const createClient = jest.fn().mockReturnValue(fakeClient);
    resolveDynamoDBClient({ clientConfig: { region: 'us-east-1' }, createClient });
    expect(createClient).toHaveBeenCalledWith({ maxAttempts: 1, region: 'us-east-1' });
  });

  it('honors an explicit maxAttempts override in clientConfig', () => {
    const fakeClient = createFakeClient();
    const createClient = jest.fn().mockReturnValue(fakeClient);
    resolveDynamoDBClient({
      clientConfig: { region: 'us-east-1', maxAttempts: 5 },
      createClient,
    });
    expect(createClient).toHaveBeenCalledWith({ region: 'us-east-1', maxAttempts: 5 });
  });

  it('builds a real DynamoDBClient through the default factory when no seam is given', () => {
    const resolved = resolveDynamoDBClient({ clientConfig: { region: 'us-east-1' } });
    expect(resolved.ownsClient).toBe(true);
    expect(resolved.ddbClient).toBeDefined();
    expect(resolved.client).toBeDefined();
    resolved.ddbClient?.destroy();
  });
});

describe('warnOnStackedRetries (DDB-01)', () => {
  const fakeLogger = () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  });
  const clientWith = (maxAttempts?: () => Promise<number>) =>
    ({ config: maxAttempts ? { maxAttempts } : {} }) as never;

  it('warns once when the injected client keeps the SDK retries', async () => {
    const logger = fakeLogger();
    await warnOnStackedRetries(
      clientWith(async () => 3),
      logger,
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('maxAttempts: 1'), {
      maxAttempts: 3,
    });
  });

  it('stays silent for a single-attempt client, a client without config, and one that cannot report', async () => {
    const logger = fakeLogger();
    await warnOnStackedRetries(
      clientWith(async () => 1),
      logger,
    );
    await warnOnStackedRetries({} as never, logger);
    await warnOnStackedRetries(
      clientWith(async () => {
        throw new Error('cannot report');
      }),
      logger,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
