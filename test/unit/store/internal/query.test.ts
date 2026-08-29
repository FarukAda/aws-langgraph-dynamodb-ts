import { scopedQuery, storeScan } from '../../../../src/store/internal/query';

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
  it('filters to rows that carry a namespace attribute', () => {
    const input = storeScan('store');
    expect(input.TableName).toBe('store');
    expect(input.FilterExpression).toBe('attribute_exists(#ns)');
    expect(input.ExpressionAttributeNames).toEqual({ '#ns': 'namespace' });
  });
});
