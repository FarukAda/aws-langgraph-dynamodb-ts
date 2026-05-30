import { beginsWithQuery, partitionQuery } from '../../../../src/checkpointer/internal/query';

describe('partitionQuery', () => {
  it('selects every item in the partition with an aliased PK equality', () => {
    expect(partitionQuery('ckpt', 'thread-1')).toEqual({
      TableName: 'ckpt',
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'PK' },
      ExpressionAttributeValues: { ':pk': 'thread-1' },
    });
  });
});

describe('beginsWithQuery', () => {
  it('builds an aliased PK-equals + SK-begins_with query, newest-first by default', () => {
    const params = beginsWithQuery('ckpt', 'thread-1', 'META##');
    expect(params).toEqual({
      TableName: 'ckpt',
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :skPrefix)',
      ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
      ExpressionAttributeValues: { ':pk': 'thread-1', ':skPrefix': 'META##' },
      ScanIndexForward: false,
    });
  });

  it('applies a limit and ascending order when requested', () => {
    const params = beginsWithQuery('ckpt', 't', 'WRITE##c#', { limit: 1, ascending: true });
    expect(params.Limit).toBe(1);
    expect(params.ScanIndexForward).toBe(true);
  });

  it('requests a strongly-consistent read when consistent is set', () => {
    const params = beginsWithQuery('ckpt', 't', 'META##', { consistent: true });
    expect(params.ConsistentRead).toBe(true);
  });

  it('omits ConsistentRead by default', () => {
    expect(beginsWithQuery('ckpt', 't', 'META##').ConsistentRead).toBeUndefined();
  });
});
