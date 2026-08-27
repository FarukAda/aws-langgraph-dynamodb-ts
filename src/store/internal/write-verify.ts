import { type PayloadDescriptor, PayloadLocation } from '../../shared/codec/codec';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import type { StoreContext } from './setup';

/**
 * True when `record`'s row already holds the S3 key `expectedS3Key` — i.e. an
 * ambiguous retry-exhaustion write actually landed server-side and only its
 * acknowledgment was lost. A failure reading this (itself possible) is not
 * treated as confirmation — fail safe, matching the pre-fix behavior.
 */
export async function writeLandedAt(
  context: StoreContext,
  record: { PK: string; SK: string },
  expectedS3Key: string,
): Promise<boolean> {
  try {
    const result = await withDynamoDBRetry(() =>
      context.client.get({
        TableName: context.tableName,
        Key: { PK: record.PK, SK: record.SK },
        ConsistentRead: true,
        ProjectionExpression: '#v',
        ExpressionAttributeNames: { '#v': 'value' },
      }),
    );
    const value = result.Item?.value as PayloadDescriptor | undefined;
    return value?.location === PayloadLocation.S3 && value.s3Key === expectedS3Key;
  } catch {
    return false;
  }
}
