import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SOCKET_TIMEOUT_MS,
  resolveDynamoDBClient,
  warnOnStackedRetries,
} from '../../../../src/shared/dynamodb/client';
import { fakeMiddlewareStack } from '../../../shared/helpers/ddb-mock';

function createFakeClient(): DynamoDBClient {
  return {
    destroy: jest.fn(),
    config: {},
    middlewareStack: fakeMiddlewareStack(),
    send: jest.fn(),
  } as unknown as DynamoDBClient;
}

/**
 * The whole `requestHandler` a client this library builds is given, written
 * out once so every assertion below pins the same object. Recursive equality
 * is exact, so a fourth field added here — or one of these three dropped —
 * fails every site that names it.
 */
const EXPECTED_REQUEST_HANDLER = {
  requestTimeout: DEFAULT_REQUEST_TIMEOUT_MS,
  socketTimeout: DEFAULT_SOCKET_TIMEOUT_MS,
  throwOnRequestTimeout: true,
};

/** The `requestHandler` options object the factory seam was handed. */
function handlerOptionsOf(createClient: jest.Mock): Record<string, boolean | number> {
  return createClient.mock.calls[0][0].requestHandler;
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
    expect(createClient).toHaveBeenCalledWith({
      maxAttempts: 1,
      requestHandler: EXPECTED_REQUEST_HANDLER,
      region: 'us-east-1',
    });
    expect(resolved.ownsClient).toBe(true);
    expect(resolved.ddbClient).toBe(fakeClient);
  });

  it('defaults to a single SDK attempt (own retry layer owns retries) when no client config is provided', () => {
    const fakeClient = createFakeClient();
    const createClient = jest.fn().mockReturnValue(fakeClient);
    const resolved = resolveDynamoDBClient({ createClient });
    expect(createClient).toHaveBeenCalledWith({
      maxAttempts: 1,
      requestHandler: EXPECTED_REQUEST_HANDLER,
    });
    expect(resolved.ownsClient).toBe(true);
  });

  it("disables the SDK's own internal retries by default, so this library's retry layer is the sole source of truth", () => {
    const fakeClient = createFakeClient();
    const createClient = jest.fn().mockReturnValue(fakeClient);
    resolveDynamoDBClient({ clientConfig: { region: 'us-east-1' }, createClient });
    expect(createClient).toHaveBeenCalledWith({
      maxAttempts: 1,
      requestHandler: EXPECTED_REQUEST_HANDLER,
      region: 'us-east-1',
    });
  });

  it('honors an explicit maxAttempts override in clientConfig', () => {
    const fakeClient = createFakeClient();
    const createClient = jest.fn().mockReturnValue(fakeClient);
    resolveDynamoDBClient({
      clientConfig: { region: 'us-east-1', maxAttempts: 5 },
      createClient,
    });
    expect(createClient).toHaveBeenCalledWith({
      maxAttempts: 5,
      region: 'us-east-1',
      requestHandler: EXPECTED_REQUEST_HANDLER,
    });
  });

  it('builds a real DynamoDBClient through the default factory when no seam is given', () => {
    const resolved = resolveDynamoDBClient({ clientConfig: { region: 'us-east-1' } });
    expect(resolved.ownsClient).toBe(true);
    expect(resolved.ddbClient).toBeDefined();
    expect(resolved.client).toBeDefined();
    resolved.ddbClient?.destroy();
  });
});

describe('the request-handler bound on a client this library builds', () => {
  const seam = (): jest.Mock => jest.fn().mockReturnValue(createFakeClient());

  /**
   * `maxAttempts: 1` bounds how many attempts *start*; nothing bounded how
   * long one runs, because every smithy handler timeout defaults to 0. These
   * are the three fields that bound it, and no others.
   */
  it('passes exactly three request-handler fields', () => {
    const createClient = seam();
    resolveDynamoDBClient({ createClient });
    expect(Object.keys(handlerOptionsOf(createClient)).sort()).toEqual([
      'requestTimeout',
      'socketTimeout',
      'throwOnRequestTimeout',
    ]);
    expect(handlerOptionsOf(createClient).requestTimeout).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(handlerOptionsOf(createClient).socketTimeout).toBe(DEFAULT_SOCKET_TIMEOUT_MS);
  });

  /**
   * Load-bearing and easy to miss: at the installed `@smithy/node-http-handler`
   * a breached `requestTimeout` only logs a warning. The handler destroys the
   * request and rejects with a retryable `TimeoutError` only when this flag is
   * set, so without it the request timeout bounds nothing at all.
   */
  it('opts in to throwing on a breached request timeout', () => {
    const createClient = seam();
    resolveDynamoDBClient({ createClient });
    expect(handlerOptionsOf(createClient).throwOnRequestTimeout).toBe(true);
  });

  /**
   * `connectionTimeout` is absent on purpose. Its timer starts at request
   * creation and is cleared only when the agent *assigns* a socket, so the
   * time a request spends queued behind `maxSockets` counts against it. At the
   * documented thousand-wide fan-out that destroys healthy writes, which this
   * library's retry layer then re-sends. Measured against a one-socket agent:
   * 14 of 100 healthy puts lost at 800 ms and 226 of 400 lost at 2 500 ms,
   * against controls of 100/100 and 400/400 with the field unset.
   */
  it('passes no connectionTimeout, which would bound the queue rather than the connect', () => {
    const createClient = seam();
    resolveDynamoDBClient({ createClient });
    expect(handlerOptionsOf(createClient)).not.toHaveProperty('connectionTimeout');
  });

  /**
   * Pinning the documented escape hatch, which is also the documented way to
   * void the bound: `options.clientConfig` spreads last, so a caller's own
   * `requestHandler` replaces this default whole. It does not merge, so a
   * caller who supplies one without a timeout gets no timeout.
   */
  it("lets a caller's own requestHandler replace the default wholesale", () => {
    const createClient = seam();
    resolveDynamoDBClient({
      clientConfig: { requestHandler: { socketTimeout: 111 } },
      createClient,
    });
    expect(createClient).toHaveBeenCalledWith({
      maxAttempts: 1,
      requestHandler: { socketTimeout: 111 },
    });
  });

  /**
   * An injected client is used as-is. The bound is a property of a client this
   * library builds, and nothing here reaches into a caller's own — see
   * `warnOnStackedRetries` for what the caller is told instead.
   */
  it('gives an injected client no handler config at all', () => {
    const createClient = seam();
    const injected = DynamoDBDocument.from(new DynamoDBClient({ region: 'us-east-1' }));
    const resolved = resolveDynamoDBClient({ client: injected, createClient });
    expect(createClient).not.toHaveBeenCalled();
    expect(resolved.client).toBe(injected);
    expect(resolved.ddbClient).toBeUndefined();
  });

  /**
   * A standing assertion, not a value check. `setSocketTimeout` registers its
   * listener immediately only below 6 000 ms; at or above it defers
   * registration by 3 000 ms and returns the deferral's timer id, which
   * `clearTimeouts()` cancels when response headers arrive — so any response
   * whose headers land inside 3 000 ms, the normal case, cancels the deferral
   * before the socket listener is ever installed. Above the threshold the
   * field silently stops doing anything and a stalled response body is
   * unbounded again, so a later commit that raises the timeouts has to fail
   * here rather than pass quietly.
   */
  it('keeps the socket timeout under the threshold at which it stops being installed', () => {
    expect(DEFAULT_SOCKET_TIMEOUT_MS).toBeLessThan(6000);
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
      clientWith(() => Promise.resolve(3)),
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
      clientWith(() => Promise.resolve(1)),
      logger,
    );
    await warnOnStackedRetries({} as never, logger);
    await warnOnStackedRetries(
      clientWith(() => {
        throw new Error('cannot report');
      }),
      logger,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
