import { resolveTtlAnchor } from '../../../../src/history/internal/ttl-anchor';

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
    await expect(resolveTtlAnchor(context, 's1', future + 99999)).resolves.toEqual({
      ttlTimestamp: future,
      refresh: false,
    });
  });

  it('falls back to the candidate and requests a refresh when the session has no stored ttl', async () => {
    await expect(resolveTtlAnchor(contextWith({}), 's1', 9999999999)).resolves.toEqual({
      ttlTimestamp: 9999999999,
      refresh: true,
    });
  });

  it('falls back to the candidate and requests a refresh when the stored ttl has already passed', async () => {
    const past = Math.floor(Date.now() / 1000) - 100;
    const context = contextWith({ Item: { ttl: past } });
    await expect(resolveTtlAnchor(context, 's1', 9999999999)).resolves.toEqual({
      ttlTimestamp: 9999999999,
      refresh: true,
    });
  });

  it('reads the session item strongly-consistently and never writes', async () => {
    const context = contextWith({ Item: { ttl: Math.floor(Date.now() / 1000) + 10_000 } });
    await resolveTtlAnchor(context, 's1', 7);
    const input = (context.client.get as jest.Mock).mock.calls[0][0];
    expect(input.Key).toEqual({ PK: 's1', SK: 'SESSION' });
    expect(input.ConsistentRead).toBe(true);
    expect(input.ProjectionExpression).toBe('#ttl');
    expect(input.ExpressionAttributeNames).toEqual({ '#ttl': 'ttl' });
  });
});
