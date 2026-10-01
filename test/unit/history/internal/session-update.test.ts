import { buildSessionUpdate } from '../../../../src/history/internal/session';

describe('buildSessionUpdate', () => {
  it('builds a transact Update that adds the count and sets timestamps + sessionId once', () => {
    const { Update } = buildSessionUpdate('history', {
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
      ':gpk': expect.stringMatching(/^SESS#\d+$/),
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
    const { Update } = buildSessionUpdate('history', {
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

  /** 1 of the default 8 shards for this id, 0 of 3: the configured count reaches the key. */
  it('shards the session row by indexShards, defaulting to 8', () => {
    const fields = { sessionId: 's1', count: 1, now: 'u', writeId: 'W1' };
    expect(buildSessionUpdate('history', fields).Update?.ExpressionAttributeValues?.[':gpk']).toBe(
      'SESS#1',
    );
    expect(
      buildSessionUpdate('history', { ...fields, indexShards: 3 }).Update
        ?.ExpressionAttributeValues?.[':gpk'],
    ).toBe('SESS#0');
  });

  it('appends a title clause when a title is given', () => {
    const { Update } = buildSessionUpdate('history', {
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
    const { Update } = buildSessionUpdate('history', {
      sessionId: 's1',
      count: 1,
      now: 'u',
      writeId: 'W1',
    });
    expect(Update?.UpdateExpression).not.toContain('#title');
  });

  it('sets the creation-anchored ttl via if_not_exists when a timestamp is given', () => {
    const { Update } = buildSessionUpdate('history', {
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
    const { Update } = buildSessionUpdate('history', {
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
    const item = buildSessionUpdate('history', {
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
    const forced = buildSessionUpdate('history', {
      sessionId: 's1',
      count: 1,
      now: 'u',
      writeId: 'W1',
      ttlTimestamp: 5000,
      forceTtlRefresh: true,
    });
    expect(forced.Update?.ConditionExpression).toBe('attribute_not_exists(#ttl) OR #ttl <= :ttl');

    const notForced = buildSessionUpdate('history', {
      sessionId: 's1',
      count: 1,
      now: 'u',
      writeId: 'W1',
      ttlTimestamp: 5000,
    });
    expect(notForced.Update?.ConditionExpression).toBeUndefined();

    const noTtl = buildSessionUpdate('history', {
      sessionId: 's1',
      count: 1,
      now: 'u',
      writeId: 'W1',
    });
    expect(noTtl.Update?.ConditionExpression).toBeUndefined();
  });

  /**
   * A session whose anchor has expired is dead to every reader, so an append
   * that heals it starts the session over: its count, creation time and title
   * are this append's, not the dead incarnation's, and the write is pinned to
   * the expired anchor it observed, so a concurrent append that restarted the
   * session first keeps its count and this one adds to it on its retry.
   */
  it('starts the session over, pinned to the expired anchor, when restart names one', () => {
    const { Update } = buildSessionUpdate('history', {
      sessionId: 's1',
      count: 2,
      now: 'u',
      writeId: 'W1',
      title: 'fresh',
      ttlTimestamp: 5000,
      forceTtlRefresh: true,
      restart: 1234,
    });
    expect(Update?.UpdateExpression).toMatch(/^SET /);
    expect(Update?.UpdateExpression).toContain('#count = :n');
    expect(Update?.UpdateExpression).not.toContain('ADD');
    expect(Update?.UpdateExpression).toContain('#c = :c');
    expect(Update?.UpdateExpression).not.toContain('if_not_exists');
    expect(Update?.UpdateExpression).toContain('#title = :title');
    expect(Update?.UpdateExpression).toContain('#ttl = :ttl');
    expect(Update?.ConditionExpression).toBe('#ttl = :expired');
    expect(Update?.ExpressionAttributeValues?.[':expired']).toBe(1234);
    expect(Update?.ExpressionAttributeValues?.[':n']).toBe(2);
  });

  it("removes the dead incarnation's title on a restart that derives none", () => {
    const { Update } = buildSessionUpdate('history', {
      sessionId: 's1',
      count: 1,
      now: 'u',
      writeId: 'W1',
      ttlTimestamp: 5000,
      forceTtlRefresh: true,
      restart: 1234,
    });
    expect(Update?.UpdateExpression).toMatch(/ REMOVE #title$/);
    expect(Update?.ExpressionAttributeNames?.['#title']).toBe('title');
    expect(Update?.ExpressionAttributeValues).not.toHaveProperty(':title');
  });

  it('still uses if_not_exists for the ttl anchor when forceTtlRefresh is not set', () => {
    const item = buildSessionUpdate('history', {
      sessionId: 's1',
      count: 1,
      now: 'u',
      writeId: 'W1',
      ttlTimestamp: 5000,
    });
    expect(item.Update?.UpdateExpression).toContain('#ttl = if_not_exists(#ttl, :ttl)');
  });
});
