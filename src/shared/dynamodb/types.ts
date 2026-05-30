import type { NativeAttributeValue } from '@aws-sdk/lib-dynamodb';

/**
 * A DynamoDB item as returned/accepted by the DocumentClient. Reads that we
 * wrote ourselves are narrowed with a single structural `as` at the mapper
 * boundary (never `as any`/`as unknown`); untrusted shared-table scans go
 * through `narrowStoreRecord`.
 */
export type DocItem = Record<string, NativeAttributeValue>;

/** A BatchWriteItem PutRequest. */
interface PutWriteRequest {
  PutRequest: { Item: DocItem };
}

/** A BatchWriteItem DeleteRequest. */
export interface DeleteWriteRequest {
  DeleteRequest: { Key: DocItem };
}

/** A single BatchWriteItem write request. */
export type WriteRequest = PutWriteRequest | DeleteWriteRequest;
