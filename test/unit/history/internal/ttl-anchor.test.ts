import { resolveTtlAnchor } from '../../../../src/history/internal/ttl-anchor';

function contextWith(getResult: { Item?: { ttl?: number } }) {
  return {
    client: { get: jest.fn().mockResolvedValue(getResult) },
    tableName: 'table',
  } as unknown as Parameters<typeof resolveTtlAnchor>[0];
}

describe('resolveTtlAnchor', () => {
  it('returns the anchor already stored on the session item', async () => {
    const context = contextWith({ Item: { ttl: 4242 } });
    await expect(resolveTtlAnchor(context, 's1', 9999)).resolves.toBe(4242);
  });

  it('falls back to the candidate when the session has no stored ttl', async () => {
    await expect(resolveTtlAnchor(contextWith({}), 's1', 9999)).resolves.toBe(9999);
  });

  it('reads the session item strongly-consistently and never writes', async () => {
    const context = contextWith({ Item: { ttl: 7 } });
    await resolveTtlAnchor(context, 's1', 7);
    const input = (context.client.get as jest.Mock).mock.calls[0][0];
    expect(input.Key).toEqual({ PK: 's1', SK: 'SESSION' });
    expect(input.ConsistentRead).toBe(true);
    expect(input.ProjectionExpression).toBe('#ttl');
    expect(input.ExpressionAttributeNames).toEqual({ '#ttl': 'ttl' });
  });
});
