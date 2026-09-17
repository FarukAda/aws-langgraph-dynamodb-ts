import type { QueryCommandInput, ScanCommandInput } from '@aws-sdk/lib-dynamodb';

import { partitionKey, sortKeyPrefix } from './keys';

/**
 * Query input for a scoped prefix.
 *
 * Accepts: `prefix` — at least one element; the first selects the partition and
 * the rest, when there are any, become a `begins_with` on the sort key. Callers
 * decide the rootless case before reaching here: an empty prefix spans every
 * partition, which is a Scan ({@link storeScan}), not a Query.
 *
 * Returns: the Query input. The `begins_with` prefix is separator-terminated,
 * so the scope `['users', 'u1']` does not also read `u10`.
 *
 * Throws: nothing.
 */
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

/**
 * Scan input for the rootless case, filtered to store items only.
 *
 * Accepts: the table name. There is nothing to scope by — this is the read for
 * a search or listing whose conditions name no concrete partition.
 *
 * Returns: the Scan input. The filter drops rows without a `namespace`
 * attribute, which is every other adapter's and every foreign row on a shared
 * table; it is applied after the read, so it saves transfer, not RCU.
 *
 * Throws: nothing.
 */
export function storeScan(tableName: string): ScanCommandInput {
  return {
    TableName: tableName,
    FilterExpression: 'attribute_exists(#ns)',
    ExpressionAttributeNames: { '#ns': 'namespace' },
  };
}

/**
 * Restrict a Query/Scan to the attributes `narrowStoreRecord` needs, leaving the
 * payload behind: a namespace listing never reads a value.
 *
 * Accepts: any Query or Scan input; its own attribute names are preserved and
 * the projection's are added.
 *
 * Returns: the same input, projected onto the row's identity and its format
 * version `v`. The version is what lets `narrowStoreRecord` refuse a row a
 * newer release wrote; without it every projected row reads as version 0. A
 * row read this way can be narrowed but not decoded — {@link readStoreItem}
 * needs the whole row.
 *
 * Throws: nothing.
 *
 * Guarantees: RCU is billed on the stored size regardless, so the saving is
 * transfer and unmarshalling, not cost.
 */
export function projectKeys<T extends QueryCommandInput | ScanCommandInput>(params: T): T {
  return {
    ...params,
    ProjectionExpression: 'PK, SK, #ns, #key, #v',
    ExpressionAttributeNames: {
      ...params.ExpressionAttributeNames,
      '#ns': 'namespace',
      '#key': 'key',
      '#v': 'v',
    },
  };
}
