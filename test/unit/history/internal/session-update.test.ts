import { buildSessionUpdateItem } from '../../../../src/history/internal/session-update';

describe('buildSessionUpdateItem', () => {
  it('builds a transact Update that adds the count and sets timestamps + sessionId once', () => {
    const { Update } = buildSessionUpdateItem('history', {
      sessionId: 's1',
      count: 2,
      now: 'u',
      writeId: 'W1',
    });
    expect(Update?.Key).toEqual({ PK: 'HIST#s1', SK: 'HISTORY#SESSION' });
    expect(Update?.UpdateExpression).toBe(
      'ADD #count :n SET #u = :u, #c = if_not_exists(#c, :c), #sid = if_not_exists(#sid, :sid), #wid = :wid, #v = :v, #gpk = :gpk, #gsk = :gsk',
    );
    expect(Update?.ExpressionAttributeValues).toEqual({
      ':n': 2,
      ':u': 'u',
      ':c': 'u',
      ':sid': 's1',
      /** The id of this append, which moves on every one; see the clause below. */
      ':wid': 'W1',
      /** Rewritten on every update, so a row states the version that last touched it. */
      ':v': 1,
      /** The recency index, rewritten on every append so a listing needs no in-memory sort. */
      ':gpk': expect.stringMatching(/^SESS#\d+$/) as unknown as string,
      ':gsk': 'u#s1',
    });
    expect(Update?.ExpressionAttributeNames).toEqual({
      '#count': 'messageCount',
      '#u': 'updatedAt',
      '#c': 'createdAt',
      '#sid': 'sessionId',
      '#wid': 'writeId',
      '#v': 'v',
      '#gpk': 'gsi1pk',
      '#gsk': 'gsi1sk',
    });
  });

  /**
   * The one field on this row that has to move on every append: it is what a
   * later delete pins on to tell the row it observed from one a newer append
   * replaced. Three of its neighbours are written once and never again, and a
   * clause in that style here would stamp the id at session creation and leave
   * it there — a pin that is present, well formed, and always passes.
   */
  it('sets the write id unconditionally, never via if_not_exists', () => {
    const { Update } = buildSessionUpdateItem('history', {
      sessionId: 's1',
      count: 1,
      now: 'u',
      writeId: 'W1',
    });
    expect(Update?.UpdateExpression).toContain('#wid = :wid');
    expect(Update?.UpdateExpression).not.toContain('if_not_exists(#wid');
    expect(Update?.ExpressionAttributeNames?.['#wid']).toBe('writeId');
    expect(Update?.ExpressionAttributeValues?.[':wid']).toBe('W1');
  });

  it('appends a title clause when a title is given', () => {
    const { Update } = buildSessionUpdateItem('history', {
      sessionId: 's1',
      count: 1,
      now: 'u',
      writeId: 'W1',
      title: 'hi',
    });
    expect(Update?.UpdateExpression).toContain('#title = if_not_exists(#title, :title)');
    expect(Update?.ExpressionAttributeNames?.['#title']).toBe('title');
    expect(Update?.ExpressionAttributeValues?.[':title']).toBe('hi');
  });

  it('omits the title clause when no title is given', () => {
    const { Update } = buildSessionUpdateItem('history', {
      sessionId: 's1',
      count: 1,
      now: 'u',
      writeId: 'W1',
    });
    expect(Update?.UpdateExpression).not.toContain('#title');
  });

  it('sets the creation-anchored ttl via if_not_exists when a timestamp is given', () => {
    const { Update } = buildSessionUpdateItem('history', {
      sessionId: 's1',
      count: 1,
      now: 'u',
      writeId: 'W1',
      ttlTimestamp: 1750,
    });
    expect(Update?.UpdateExpression).toContain('#ttl = if_not_exists(#ttl, :ttl)');
    expect(Update?.ExpressionAttributeNames?.['#ttl']).toBe('ttl');
    expect(Update?.ExpressionAttributeValues?.[':ttl']).toBe(1750);
  });

  it('omits the ttl clause when no timestamp is given', () => {
    const { Update } = buildSessionUpdateItem('history', {
      sessionId: 's1',
      count: 1,
      now: 'u',
      writeId: 'W1',
      title: 'x',
    });
    expect(Update?.UpdateExpression).not.toContain('#ttl');
    expect(Update?.ExpressionAttributeNames?.['#ttl']).toBeUndefined();
  });

  it('force-overwrites the ttl anchor instead of if_not_exists when forceTtlRefresh is set', () => {
    const item = buildSessionUpdateItem('history', {
      sessionId: 's1',
      count: 1,
      now: 'u',
      writeId: 'W1',
      ttlTimestamp: 5000,
      forceTtlRefresh: true,
    });
    expect(item.Update?.UpdateExpression).toContain('#ttl = :ttl');
    expect(item.Update?.UpdateExpression).not.toContain('if_not_exists(#ttl');
  });

  it('adds a monotonic ConditionExpression only when forceTtlRefresh is set', () => {
    const forced = buildSessionUpdateItem('history', {
      sessionId: 's1',
      count: 1,
      now: 'u',
      writeId: 'W1',
      ttlTimestamp: 5000,
      forceTtlRefresh: true,
    });
    expect(forced.Update?.ConditionExpression).toBe('attribute_not_exists(#ttl) OR #ttl <= :ttl');

    const notForced = buildSessionUpdateItem('history', {
      sessionId: 's1',
      count: 1,
      now: 'u',
      writeId: 'W1',
      ttlTimestamp: 5000,
    });
    expect(notForced.Update?.ConditionExpression).toBeUndefined();

    const noTtl = buildSessionUpdateItem('history', {
      sessionId: 's1',
      count: 1,
      now: 'u',
      writeId: 'W1',
    });
    expect(noTtl.Update?.ConditionExpression).toBeUndefined();
  });

  it('still uses if_not_exists for the ttl anchor when forceTtlRefresh is not set', () => {
    const item = buildSessionUpdateItem('history', {
      sessionId: 's1',
      count: 1,
      now: 'u',
      writeId: 'W1',
      ttlTimestamp: 5000,
    });
    expect(item.Update?.UpdateExpression).toContain('#ttl = if_not_exists(#ttl, :ttl)');
  });
});
