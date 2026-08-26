import { DynamoDBClient, type DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

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
