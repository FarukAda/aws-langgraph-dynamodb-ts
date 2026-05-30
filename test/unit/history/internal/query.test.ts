import { messageQuery, sessionItemsQuery } from '../../../../src/history/internal/query';

describe('sessionItemsQuery', () => {
  it('selects every item in the session partition', () => {
    const input = sessionItemsQuery('history', 's1');
    expect(input.KeyConditionExpression).toBe('#pk = :pk');
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 's1' });
  });
});

describe('messageQuery', () => {
  it('selects message items in chronological order', () => {
    const input = messageQuery('history', 's1');
    expect(input.KeyConditionExpression).toBe('#pk = :pk AND begins_with(#sk, :skp)');
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 's1', ':skp': 'MSG#' });
    expect(input.ScanIndexForward).toBe(true);
  });
});
