import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { buildStoreItem, readStoreItem } from '../../../../src/store/internal/item-mapper';
import type { StoreContext } from '../../../../src/store/internal/setup';

function context(): StoreContext {
  return { client: {} as never, tableName: 's', serde: JSON_SERDE, logger: SILENT_LOGGER };
}

describe('store item-mapper', () => {
  it('builds a record with keys, namespace, timestamps, and round-trips the value', async () => {
    const record = await buildStoreItem(
      context(),
      ['users', 'u1'],
      'profile',
      { name: 'Faruk' },
      {
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
      },
    );
    expect(record.PK).toBe('users');
    expect(record.SK).toBe('u1#profile');
    expect(record.namespace).toEqual(['users', 'u1']);
    expect(record.embedding).toBeUndefined();

    const item = await readStoreItem(context(), record);
    expect(item.value).toEqual({ name: 'Faruk' });
    expect(item.key).toBe('profile');
    expect(item.namespace).toEqual(['users', 'u1']);
    expect(item.createdAt).toEqual(new Date('2024-01-01T00:00:00.000Z'));
    expect(item.updatedAt).toEqual(new Date('2024-01-02T00:00:00.000Z'));
  });

  it('stores embedding and ttl when provided', async () => {
    const record = await buildStoreItem(
      context(),
      ['n'],
      'k',
      { a: 1 },
      {
        createdAt: 'x',
        updatedAt: 'y',
        embedding: [0.1, 0.2],
        ttlTimestamp: 1750,
      },
    );
    expect(record.embedding).toEqual([0.1, 0.2]);
    expect(record.ttl).toBe(1750);
  });
});
