import type { QueryCommandInput, ScanCommandInput } from '@aws-sdk/lib-dynamodb';

import { partitionKey, sortKeyPrefix, storePartitionPrefix } from './keys';

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
 * Returns: the Scan input, selecting this adapter's **key space** first and its
 * rows within it second. `begins_with(PK, 'STORE#')` is what restricts the
 * read: every store row carries that tag and no other adapter's partition key
 * can, so a row belonging to another adapter or to another application never
 * reaches the narrow. The `namespace` test stays behind it as a second line of
 * defence over the store's own partitions.
 *
 * Selecting on the attribute alone was not equivalent. It admitted any row on a
 * shared table that happens to carry a `namespace` attribute, and since a row
 * stamped with a format version above this release is *reported* rather than
 * skipped, one foreign row was enough to fail `search([])` and
 * `listNamespaces()` outright. Nothing legitimate is lost: `narrowStoreRecord`
 * already requires `PK` to equal `partitionKey(namespace)`, which carries the
 * same tag, so every row the tag excludes was dropped after the read anyway.
 *
 * The extra condition is free. A filter "is applied after a `Scan` finishes but
 * before the results are returned. Therefore, a `Scan` consumes the same amount
 * of read capacity, regardless of whether a filter expression is present"
 * (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Scan.html).
 * It saves transfer, not RCU — which is also why it cannot replace the narrow.
 *
 * Throws: nothing.
 */
export function storeScan(tableName: string): ScanCommandInput {
  return {
    TableName: tableName,
    FilterExpression: 'begins_with(#pk, :pkp) AND attribute_exists(#ns)',
    ExpressionAttributeNames: { '#pk': 'PK', '#ns': 'namespace' },
    ExpressionAttributeValues: { ':pkp': storePartitionPrefix() },
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
