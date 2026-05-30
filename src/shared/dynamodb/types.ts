import type { NativeAttributeValue } from '@aws-sdk/lib-dynamodb';

/** A DynamoDB item as returned/accepted by the DocumentClient. */
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
