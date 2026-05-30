import { establishTtlAnchor } from '../../../../src/history/internal/ttl-anchor';

function contextWith(updateResult: { Attributes?: { ttl?: number } }) {
  return {
    client: { update: jest.fn().mockResolvedValue(updateResult) },
    tableName: 'table',
  } as unknown as Parameters<typeof establishTtlAnchor>[0];
}

describe('establishTtlAnchor', () => {
  it('returns the authoritative anchor the conditional update resolves to', async () => {
    const context = contextWith({ Attributes: { ttl: 4242 } });
    await expect(establishTtlAnchor(context, 's1', 9999)).resolves.toBe(4242);
  });

  it('falls back to the candidate when the update returns no ttl', async () => {
    await expect(establishTtlAnchor(contextWith({}), 's1', 9999)).resolves.toBe(9999);
  });

  it('issues a conditional if_not_exists update with ALL_NEW', async () => {
    const context = contextWith({ Attributes: { ttl: 7 } });
    await establishTtlAnchor(context, 's1', 7);
    const input = (context.client.update as jest.Mock).mock.calls[0][0];
    expect(input.Key).toEqual({ PK: 's1', SK: 'SESSION' });
    expect(input.UpdateExpression).toBe('SET #ttl = if_not_exists(#ttl, :cand)');
    expect(input.ExpressionAttributeValues).toEqual({ ':cand': 7 });
    expect(input.ReturnValues).toBe('ALL_NEW');
  });
});
