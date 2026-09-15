import { DynamoDBClient, type DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

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
 * retry layer is the only one. An injected client keeps whatever it was built
 * with — see {@link warnOnStackedRetries}.
 */
export function resolveDynamoDBClient(options: ResolveClientOptions): ResolvedDynamoDBClient {
  if (options.client) {
    return { ddbClient: undefined, client: options.client, ownsClient: false };
  }
  const createClient = options.createClient ?? ((config) => new DynamoDBClient(config));
  const ddbClient = createClient({ maxAttempts: 1, ...options.clientConfig });
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
