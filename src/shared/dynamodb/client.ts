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
  createClient?: (config: DynamoDBClientConfig) => DynamoDBClient;
}

/**
 * Resolve the DocumentClient for an adapter. An injected `client` is used as-is
 * and not owned; otherwise a client is built from `clientConfig` (via the
 * `createClient` seam) and owned, so the adapter destroys it on `destroy()`.
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
 * Warn once when an injected client keeps the SDK's own retries. They run
 * inside every attempt of this library's retry layer, so the budget the
 * constants and README describe multiplies (5 × 3 requests per operation with
 * the SDK default) and a throttling event turns into a retry storm. A client
 * that cannot report its setting is left alone; the check never throws.
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
