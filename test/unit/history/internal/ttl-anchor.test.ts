import { readSessionTtlAnchor } from '../../../../src/history/internal/ttl-anchor';

function contextWith(getResult: { Item?: { ttl?: number } }) {
  return {
    client: { get: jest.fn().mockResolvedValue(getResult) },
    tableName: 'table',
  } as unknown as Parameters<typeof readSessionTtlAnchor>[0];
}

describe('readSessionTtlAnchor', () => {
  it('returns the stored ttl when the session metadata exists', async () => {
    const context = contextWith({ Item: { ttl: 4242 } });
    await expect(readSessionTtlAnchor(context, 'session-1')).resolves.toBe(4242);
  });

  it('returns undefined when no metadata or no ttl is stored', async () => {
    await expect(readSessionTtlAnchor(contextWith({}), 'session-1')).resolves.toBeUndefined();
    await expect(
      readSessionTtlAnchor(contextWith({ Item: {} }), 'session-1'),
    ).resolves.toBeUndefined();
  });

  it('issues a strongly-consistent, projected get on the session metadata item', async () => {
    const context = contextWith({ Item: { ttl: 7 } });
    await readSessionTtlAnchor(context, 'session-1');
    const getMock = (context.client.get as jest.Mock).mock.calls[0][0];
    expect(getMock.Key).toEqual({ PK: 'session-1', SK: 'SESSION' });
    expect(getMock.ConsistentRead).toBe(true);
    expect(getMock.ProjectionExpression).toBe('#ttl');
  });
});
