/**
 * Shared DynamoDB client resolution for DynamoDBSaver / DynamoDBStore /
 * DynamoDBChatMessageHistory.
 *
 * Each module supports two construction modes:
 *   1. Pass `client` (pre-built DynamoDBDocument): we do not own it and skip cleanup.
 *   2. Pass `clientConfig` (or nothing): we build our own client and own its lifecycle.
 *
 * This helper captures the if/else and the `ownsClient` flag in one place.
 */

import { DynamoDBClient, type DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

export interface ResolvedDynamoDBClient {
  /** Underlying DynamoDB client — undefined when an external client was injected. */
  ddbClient: DynamoDBClient | undefined;
  /** DocumentClient wrapper used for all operations. */
  client: DynamoDBDocument;
  /** True when this library owns the underlying client and must destroy it. */
  ownsClient: boolean;
}

export function resolveDynamoDBClient(options: {
  client?: DynamoDBDocument;
  clientConfig?: DynamoDBClientConfig;
}): ResolvedDynamoDBClient {
  if (options.client) {
    return { ddbClient: undefined, client: options.client, ownsClient: false };
  }
  const ddbClient = new DynamoDBClient(options.clientConfig || {});
  return { ddbClient, client: DynamoDBDocument.from(ddbClient), ownsClient: true };
}
