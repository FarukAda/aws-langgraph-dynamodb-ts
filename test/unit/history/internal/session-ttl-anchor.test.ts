import { parseSessionId } from '../../../../src/history/internal/parse';
import { resolveTtlAnchor } from '../../../../src/history/internal/session';

const SESSION_ID = parseSessionId('s1');

function contextWith(getResult: { Item?: { ttl?: number } }) {
  return {
    client: { get: jest.fn().mockResolvedValue(getResult) },
    tableName: 'table',
  } as unknown as Parameters<typeof resolveTtlAnchor>[0];
}

describe('resolveTtlAnchor', () => {
  it('returns the anchor already stored on the session item, unchanged, when it is still in the future', async () => {
    const future = Math.floor(Date.now() / 1000) + 10_000;
    const context = contextWith({ Item: { ttl: future } });
    await expect(resolveTtlAnchor(context, SESSION_ID, future + 99999)).resolves.toEqual({
      ttlTimestamp: future,
      refresh: false,
    });
  });

  it('falls back to the candidate and requests a refresh when the session has no stored ttl', async () => {
    await expect(resolveTtlAnchor(contextWith({}), SESSION_ID, 9999999999)).resolves.toEqual({
      ttlTimestamp: 9999999999,
      refresh: true,
    });
  });

  /**
   * An expired anchor is a dead incarnation of the session: every reader
   * already hides it. The value is handed back so the append that heals it
   * can start the session over under a pin on exactly that anchor, rather
   * than add its messages to a conversation nobody can read any more.
   */
  it('names the expired anchor it found, so the append can start the session over under it', async () => {
    const past = Math.floor(Date.now() / 1000) - 100;
    const context = contextWith({ Item: { ttl: past } });
    await expect(resolveTtlAnchor(context, SESSION_ID, 9999999999)).resolves.toEqual({
      ttlTimestamp: 9999999999,
      refresh: true,
      expiredAnchor: past,
    });
  });

  it('reads the session item strongly-consistently and never writes', async () => {
    const context = contextWith({ Item: { ttl: Math.floor(Date.now() / 1000) + 10_000 } });
    await resolveTtlAnchor(context, SESSION_ID, 7);
    const input = (context.client.get as jest.Mock).mock.calls[0][0];
    expect(input.Key).toEqual({ PK: 'HIST#s1', SK: 'HISTORY#SESSION' });
    expect(input.ConsistentRead).toBe(true);
    expect(input.ProjectionExpression).toBe('#ttl');
    expect(input.ExpressionAttributeNames).toEqual({ '#ttl': 'ttl' });
  });
});
