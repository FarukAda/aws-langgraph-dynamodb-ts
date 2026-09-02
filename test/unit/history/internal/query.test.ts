import { messageQuery, sessionItemsQuery } from '../../../../src/history/internal/query';

describe('sessionItemsQuery', () => {
  it('selects every item in the session partition', () => {
    const input = sessionItemsQuery('history', 's1');
    expect(input.KeyConditionExpression).toBe('#pk = :pk');
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'HIST#s1' });
    expect(input.ConsistentRead).toBeUndefined();
  });

  it('sets ConsistentRead when requested', () => {
    const input = sessionItemsQuery('history', 's1', { consistent: true });
    expect(input.ConsistentRead).toBe(true);
  });
});

describe('messageQuery', () => {
  it('selects message items in chronological order', () => {
    const input = messageQuery('history', 's1');
    expect(input.KeyConditionExpression).toBe('#pk = :pk AND begins_with(#sk, :skp)');
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'HIST#s1', ':skp': 'HISTORY#MSG#' });
    expect(input.ScanIndexForward).toBe(true);
    expect(input.ConsistentRead).toBeUndefined();
  });

  it('sets ConsistentRead when requested', () => {
    expect(messageQuery('history', 's1', { consistent: true }).ConsistentRead).toBe(true);
  });
});

describe('messageQuery window options (HIST-06)', () => {
  it('reads newest-first with a page cap when descending and limit are set', () => {
    const input = messageQuery('history', 's1', { descending: true, limit: 5 });
    expect(input.ScanIndexForward).toBe(false);
    expect(input.Limit).toBe(5);
  });

  it('bounds the sort key from above when beforeSortKey is set', () => {
    const input = messageQuery('history', 's1', { beforeSortKey: 'HISTORY#MSG#0ABC' });
    expect(input.KeyConditionExpression).toBe('#pk = :pk AND #sk BETWEEN :skp AND :before');
    expect(input.ExpressionAttributeValues).toEqual({
      ':pk': 'HIST#s1',
      ':skp': 'HISTORY#MSG#',
      ':before': 'HISTORY#MSG#0ABC',
    });
  });
});
