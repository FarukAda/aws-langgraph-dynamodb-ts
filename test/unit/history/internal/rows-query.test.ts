import { parseSessionId } from '../../../../src/history/internal/parse';
import { messageQuery, sessionItemsQuery } from '../../../../src/history/internal/rows';

const SESSION_ID = parseSessionId('s1');

describe('sessionItemsQuery', () => {
  it('selects every item in the session partition', () => {
    const input = sessionItemsQuery('history', SESSION_ID);
    expect(input.KeyConditionExpression).toBe('#pk = :pk');
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'HIST#s1' });
    expect(input.ConsistentRead).toBeUndefined();
  });

  it('sets ConsistentRead when requested', () => {
    const input = sessionItemsQuery('history', SESSION_ID, { consistent: true });
    expect(input.ConsistentRead).toBe(true);
  });
});

describe('messageQuery', () => {
  it('selects message items in chronological order', () => {
    const input = messageQuery('history', SESSION_ID);
    expect(input.KeyConditionExpression).toBe('#pk = :pk AND begins_with(#sk, :skp)');
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'HIST#s1', ':skp': 'HISTORY#MSG#' });
    expect(input.ScanIndexForward).toBe(true);
    expect(input.ConsistentRead).toBeUndefined();
  });

  it('sets ConsistentRead when requested', () => {
    expect(messageQuery('history', SESSION_ID, { consistent: true }).ConsistentRead).toBe(true);
  });
});

describe('messageQuery window options', () => {
  it('reads newest-first with a page cap when descending and limit are set', () => {
    const input = messageQuery('history', SESSION_ID, { descending: true, limit: 5 });
    expect(input.ScanIndexForward).toBe(false);
    expect(input.Limit).toBe(5);
  });

  it('bounds the sort key from above when beforeSortKey is set', () => {
    const input = messageQuery('history', SESSION_ID, { beforeSortKey: 'HISTORY#MSG#0ABC' });
    expect(input.KeyConditionExpression).toBe('#pk = :pk AND #sk BETWEEN :skp AND :before');
    expect(input.ExpressionAttributeValues).toEqual({
      ':pk': 'HIST#s1',
      ':skp': 'HISTORY#MSG#',
      ':before': 'HISTORY#MSG#0ABC',
    });
  });
});
