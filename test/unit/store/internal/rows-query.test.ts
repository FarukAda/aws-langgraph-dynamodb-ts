import { scopedQuery, storeScan } from '../../../../src/store/internal/rows';

describe('scopedQuery', () => {
  it('builds a PK-only query when the prefix has no namespace tail', () => {
    const input = scopedQuery('store', ['users']);
    expect(input.KeyConditionExpression).toBe('#pk = :pk');
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'STORE#users' });
    expect(input.ExpressionAttributeNames).toEqual({ '#pk': 'PK' });
  });

  it('adds a begins_with condition when the prefix has a namespace tail', () => {
    const input = scopedQuery('store', ['users', 'u1']);
    expect(input.KeyConditionExpression).toBe('#pk = :pk AND begins_with(#sk, :skp)');
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'STORE#users', ':skp': 'u1#' });
    expect(input.ExpressionAttributeNames).toEqual({ '#pk': 'PK', '#sk': 'SK' });
  });
});

describe('storeScan', () => {
  /**
   * The key restriction comes first and the attribute test second. Selecting on
   * the attribute alone admitted any row on a shared table that carries a
   * `namespace`, which `test/unit/shared/key-space-disjointness.test.ts` pins
   * by behaviour; this pins the request that behaviour rests on.
   */
  it('restricts the scan to the store partition tag, then to store rows', () => {
    const input = storeScan('store');
    expect(input.TableName).toBe('store');
    expect(input.FilterExpression).toBe('begins_with(#pk, :pkp) AND attribute_exists(#ns)');
    expect(input.ExpressionAttributeNames).toEqual({ '#pk': 'PK', '#ns': 'namespace' });
    expect(input.ExpressionAttributeValues).toEqual({ ':pkp': 'STORE#' });
  });
});
