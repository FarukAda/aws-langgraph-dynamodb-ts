import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import {
  buildStoreItem,
  narrowStoreRecord,
  readStoreItem,
} from '../../../../src/store/internal/item-mapper';
import type { StoreContext } from '../../../../src/store/internal/setup';

function context(): StoreContext {
  return {
    client: {} as never,
    tableName: 's',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    maxSearchCandidates: 1000,
    maxScanItems: 10000,
    vectorScoreDirection: 'relevance',
  };
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
    expect(record.PK).toBe('STORE#users');
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

  it('narrows a store row and rejects a foreign row', () => {
    expect(
      narrowStoreRecord({ PK: 'STORE#users', SK: 'k', namespace: ['users'], key: 'k' }),
    ).toBeDefined();
    expect(narrowStoreRecord({ SK: 'META##c' })).toBeUndefined();
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

  it('appends a nonce to the S3 keyParts only when one is provided, and carries it onto rev', async () => {
    const seenParts: string[][] = [];
    const ctx: StoreContext = {
      client: {} as never,
      tableName: 's',
      serde: JSON_SERDE,
      logger: SILENT_LOGGER,
      maxSearchCandidates: 1000,
      maxScanItems: 10000,
      vectorScoreDirection: 'relevance',
      offloader: {
        shouldOffload: () => true,
        buildKey: (parts: readonly string[]) => {
          seenParts.push([...parts]);
          return parts.join('/');
        },
        upload: async (key: string) => key,
      } as never,
    };
    const withNonce = await buildStoreItem(
      ctx,
      ['n'],
      'k',
      { a: 1 },
      { createdAt: 'c', updatedAt: 'u', nonce: 'abc' },
    );
    expect(seenParts[0]).toEqual(['n', 'k', 'abc']);
    expect(withNonce.rev).toBe('abc');

    const withoutNonce = await buildStoreItem(
      ctx,
      ['n'],
      'k',
      { a: 1 },
      { createdAt: 'c', updatedAt: 'u' },
    );
    expect(seenParts[1]).toEqual(['n', 'k']);
    expect(withoutNonce.rev).toBeUndefined();
  });
});

describe('narrowStoreRecord key consistency (SEC-03)', () => {
  const value = {
    location: PayloadLocation.INLINE,
    serdeType: 'json',
    compressed: false,
    bytes: new Uint8Array(),
  };
  const row = (over: Record<string, unknown>) => ({
    PK: 'STORE#users',
    SK: 'u1#profile',
    namespace: ['users', 'u1'],
    key: 'profile',
    value,
    createdAt: 'c',
    updatedAt: 'u',
    ...over,
  });

  it('accepts a row whose namespace/key agree with the DynamoDB key it was found at', () => {
    expect(narrowStoreRecord(row({}))).toBeDefined();
  });

  it('rejects a row whose namespace or key disagree with its partition or sort key', () => {
    expect(narrowStoreRecord(row({ namespace: ['tenantB', 'u1'] }))).toBeUndefined();
    expect(narrowStoreRecord(row({ key: 'other' }))).toBeUndefined();
    expect(narrowStoreRecord(row({ key: 42 }))).toBeUndefined();
  });
});
