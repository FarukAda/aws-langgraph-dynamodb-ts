import { buildSessionUpdate } from '../../../../src/history/internal/session-update';

describe('buildSessionUpdate', () => {
  it('adds the count and sets timestamps + sessionId once', () => {
    const input = buildSessionUpdate('history', { sessionId: 's1', count: 2, now: 'u' });
    expect(input.Key).toEqual({ PK: 's1', SK: 'SESSION' });
    expect(input.UpdateExpression).toBe(
      'ADD #count :n SET #u = :u, #c = if_not_exists(#c, :c), #sid = if_not_exists(#sid, :sid)',
    );
    expect(input.ExpressionAttributeValues).toEqual({
      ':n': 2,
      ':u': 'u',
      ':c': 'u',
      ':sid': 's1',
    });
    expect(input.ExpressionAttributeNames).toEqual({
      '#count': 'messageCount',
      '#u': 'updatedAt',
      '#c': 'createdAt',
      '#sid': 'sessionId',
    });
  });

  it('appends a creation-anchored title clause when a title is given', () => {
    const input = buildSessionUpdate('history', {
      sessionId: 's1',
      count: 1,
      now: 'u',
      title: 'hi',
    });
    expect(input.UpdateExpression).toContain('#title = if_not_exists(#title, :title)');
    expect(input.ExpressionAttributeNames?.['#title']).toBe('title');
    expect(input.ExpressionAttributeValues?.[':title']).toBe('hi');
  });

  it('appends a creation-anchored ttl clause when a ttl is given', () => {
    const input = buildSessionUpdate('history', {
      sessionId: 's1',
      count: 1,
      now: 'u',
      ttlTimestamp: 1750,
    });
    expect(input.UpdateExpression).toContain('#ttl = if_not_exists(#ttl, :ttl)');
    expect(input.ExpressionAttributeValues?.[':ttl']).toBe(1750);
  });

  it('omits the title and ttl clauses when neither is given', () => {
    const input = buildSessionUpdate('history', { sessionId: 's1', count: 1, now: 'u' });
    expect(input.UpdateExpression).not.toContain('#title');
    expect(input.UpdateExpression).not.toContain('#ttl');
  });
});
