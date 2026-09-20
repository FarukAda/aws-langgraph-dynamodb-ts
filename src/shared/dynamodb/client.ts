import { DynamoDBClient, type DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import { DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_SOCKET_TIMEOUT_MS } from '../constants';
import type { Logger } from '../logging/logger';

/** A resolved DynamoDB client plus its ownership flag. */
export interface ResolvedDynamoDBClient {
  ddbClient: DynamoDBClient | undefined;
  client: DynamoDBDocument;
  ownsClient: boolean;
}

/** Options for {@link resolveDynamoDBClient}. */
export interface ResolveClientOptions {
  client?: DynamoDBDocument;
  clientConfig?: DynamoDBClientConfig;
  /** @internal Test seam and dependency-injection hook for constructing the client. */
  createClient?: (config: DynamoDBClientConfig) => DynamoDBClient;
}

/**
 * The DocumentClient an adapter will use, and whether it owns it.
 *
 * Accepts: `client` — an injected DocumentClient, used as-is; `clientConfig` —
 * used to build one when no client is injected; `createClient` — the test seam
 * that builds it. `validateBaseAdapterOptions` rejects an injected client given
 * alongside either of the other two, so only one branch is ever taken.
 *
 * Returns: the document client, the raw client behind it when this call built
 * one, and `ownsClient` — true only then. An injected client is never
 * destroyed by `destroy()`; it may be shared with the caller's own code and
 * with the other adapters.
 *
 * Throws: whatever the SDK constructor throws for an unusable config.
 *
 * Guarantees: a client this call builds gets `maxAttempts: 1` unless the config
 * overrides it, so the SDK performs no retries of its own and this library's
 * retry layer is the only one. It also gets a default request handler that
 * bounds how long one attempt may run, which `maxAttempts` alone does not. A
 * `requestHandler` in `clientConfig` replaces that default whole rather than
 * merging with it — the documented escape hatch, and equally the documented
 * way to give up the bound. An injected client keeps whatever it was built
 * with — see {@link warnOnStackedRetries}.
 */
export function resolveDynamoDBClient(options: ResolveClientOptions): ResolvedDynamoDBClient {
  if (options.client) {
    return { ddbClient: undefined, client: options.client, ownsClient: false };
  }
  const createClient = options.createClient ?? ((config) => new DynamoDBClient(config));
  /**
   * `throwOnRequestTimeout` is what makes the request timeout a bound: without
   * it the handler only logs a warning when the timeout is breached.
   * `socketTimeout` is here because `requestTimeout` stops applying the moment
   * response *headers* arrive — the handler resolves there and clears its
   * timers — so it says nothing about a response body that then stalls
   * mid-stream, and an idle timer does. No `connectionTimeout` is passed,
   * deliberately — its timer starts when the request is created and is
   * cleared only when the agent *assigns* a socket, so the time a request
   * spends queued behind `maxSockets` counts against it. At the thousand-wide
   * fan-out this package documents, any value short enough to be useful
   * destroys healthy writes that this library then retries, and any value
   * long enough to be safe bounds nothing the request timeout does not
   * already bound.
   */
  const ddbClient = createClient({
    maxAttempts: 1,
    requestHandler: {
      requestTimeout: DEFAULT_REQUEST_TIMEOUT_MS,
      socketTimeout: DEFAULT_SOCKET_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    },
    ...options.clientConfig,
  });
  return { ddbClient, client: DynamoDBDocument.from(ddbClient), ownsClient: true };
}

/**
 * Warn once when an injected client keeps the SDK's own retries.
 *
 * Accepts: `client` — the caller's. A client that cannot report its setting —
 * a stub, a mock, a future SDK shape — is left alone.
 *
 * Returns: nothing. Deliberately not awaited by its callers: it is a warning
 * about a caller-supplied client, not a precondition for using it, so
 * constructing an adapter stays free of I/O.
 *
 * Throws: nothing, ever. The SDK's own config resolution can reject, and a
 * rejection here would surface as an unhandled rejection from a constructor
 * that did nothing wrong.
 *
 * Guarantees: the SDK's retries run inside every attempt of this library's
 * retry layer, so the budget the constants and README describe multiplies (5 ×
 * 3 requests per operation at the SDK default) and a throttling event turns
 * into a retry storm. Saying so once, at construction, is the only place the
 * caller can act on it.
 *
 * The one gap a deadline cannot cover. A tokened write's budget is bounded by
 * `MAX_WRITE_LIFETIME_MS`, but that bound is checked between attempts: it can
 * refuse to start another wait, and it cannot shorten an attempt already in
 * flight. An injected client that retries internally turns one of this
 * library's attempts into several of its own, so the time spent inside a
 * single attempt stops being bounded by anything this library sets — which is
 * why the warning says to construct it with `maxAttempts: 1`.
 *
 * `maxAttempts: 1` is necessary but not sufficient. The per-attempt bound
 * holds for an injected client only if it also carries its own request
 * timeout: a client this library builds is given one
 * ({@link resolveDynamoDBClient}), and an injected client is used exactly as
 * handed over, so one without a handler timeout leaves a single attempt
 * unbounded even with the SDK's retries switched off.
 */
export async function warnOnStackedRetries(
  client: DynamoDBDocument,
  logger: Logger,
): Promise<void> {
  const report = (client as { config?: { maxAttempts?: () => Promise<number> } }).config
    ?.maxAttempts;
  if (typeof report !== 'function') return;
  try {
    const maxAttempts = await report();
    if (maxAttempts > 1) {
      logger.warn(
        "injected DynamoDB client keeps the SDK's own retries; they stack inside this library's " +
          'retry budget — construct it with maxAttempts: 1 unless that is intended',
        { maxAttempts },
      );
    }
  } catch {
    /** A client that cannot report its retry setting is left alone. */
  }
}
