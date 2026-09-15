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
        embeddings: [[0.1, 0.2]],
        ttlTimestamp: 1750,
      },
    );
    expect(record.embeddings).toEqual([[0.1, 0.2]]);
    expect(record.ttl).toBe(1750);
  });

  /**
   * `rev` is the row's revision token for the compare-and-swap, and nothing
   * else. It used to double as the S3 key's uniquifier, which tied a DynamoDB
   * write identity to an object identity; the object is addressed by its
   * content hash under the row's own path instead.
   */
  it('keeps rev off the S3 key path and carries it onto the record', async () => {
    const seenParts: string[][] = [];
    const ctx: StoreContext = {
      ...context(),
      offloader: {
        shouldOffload: () => true,
        buildKey(parts: readonly string[], hash: string) {
          seenParts.push([...parts]);
          return [...parts, hash].join('/');
        },
        upload: async (key: string) => key,
      } as never,
    };

    const withRev = await buildStoreItem(
      ctx,
      ['n'],
      'k',
      { a: 1 },
      { createdAt: 'c', updatedAt: 'u', rev: 'abc' },
    );
    const withoutRev = await buildStoreItem(
      ctx,
      ['n'],
      'k',
      { a: 1 },
      { createdAt: 'c', updatedAt: 'u' },
    );

    expect(seenParts).toEqual([
      ['n', 'k'],
      ['n', 'k'],
    ]);
    expect(withRev.rev).toBe('abc');
    expect(withoutRev.rev).toBeUndefined();
    expect((withoutRev.value as { s3Key: string }).s3Key).toBe(
      (withRev.value as { s3Key: string }).s3Key,
    );
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

describe('narrowStoreRecord refuses a row from a newer format version (STORE-11)', () => {
  const row = {
    PK: 'STORE#n',
    SK: 'k',
    namespace: ['n'],
    key: 'k',
    value: { location: 'INLINE', serdeType: 'json', compressed: false, bytes: new Uint8Array() },
    createdAt: 'c',
    updatedAt: 'u',
  };

  it('reads a row without a version, and one at the supported version', () => {
    expect(narrowStoreRecord(row as never)).toBeDefined();
    expect(narrowStoreRecord({ ...row, v: 1 } as never)).toBeDefined();
  });

  /** Skipping it would hide an item that exists, so it fails loudly. */
  it('throws FORMAT_UNSUPPORTED rather than hiding a newer row', () => {
    expect(() => narrowStoreRecord({ ...row, v: 99 } as never)).toThrow(/format version 99/);
  });

  it('still skips a row whose attributes disagree with its key', () => {
    expect(narrowStoreRecord({ ...row, key: 'other', v: 99 } as never)).toBeUndefined();
  });
});

describe('buildStoreItem stamps the row format version', () => {
  it('writes v on every item', async () => {
    const record = await buildStoreItem(
      { serde: JSON_SERDE } as never,
      ['n'],
      'k',
      { a: 1 },
      { createdAt: 'c', updatedAt: 'u' },
    );
    expect(record.v).toBe(1);
  });
});
