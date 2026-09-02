import type { QueryCommandInput, ScanCommandInput } from '@aws-sdk/lib-dynamodb';

import { partitionKey, sortKeyPrefix } from './keys';

/** Query input for a scoped prefix (PK = prefix[0], optional SK begins_with). */
export function scopedQuery(tableName: string, prefix: string[]): QueryCommandInput {
  const skPrefix = sortKeyPrefix(prefix);
  if (skPrefix.length === 0) {
    return {
      TableName: tableName,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'PK' },
      ExpressionAttributeValues: { ':pk': partitionKey(prefix) },
    };
  }
  return {
    TableName: tableName,
    KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :skp)',
    ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
    ExpressionAttributeValues: { ':pk': partitionKey(prefix), ':skp': skPrefix },
  };
}

/** Scan input for the rootless case, filtered to store items only. */
export function storeScan(tableName: string): ScanCommandInput {
  return {
    TableName: tableName,
    FilterExpression: 'attribute_exists(#ns)',
    ExpressionAttributeNames: { '#ns': 'namespace' },
  };
}

/**
 * Restrict a Query/Scan to the attributes `narrowStoreRecord` needs, leaving the
 * payload behind: a namespace listing never reads a value. RCU is billed on
 * the stored size regardless, so the saving is transfer and unmarshalling.
 */
export function projectKeys<T extends QueryCommandInput | ScanCommandInput>(params: T): T {
  return {
    ...params,
    ProjectionExpression: 'PK, SK, #ns, #key',
    ExpressionAttributeNames: {
      ...params.ExpressionAttributeNames,
      '#ns': 'namespace',
      '#key': 'key',
    },
  };
}
