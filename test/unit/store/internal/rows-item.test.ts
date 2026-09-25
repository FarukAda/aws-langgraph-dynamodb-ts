import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import {
  buildStoreItem,
  narrowStoreRecord,
  readStoreItem,
} from '../../../../src/store/internal/rows';
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

describe('store rows: item', () => {
  it('builds a record with keys, namespace, timestamps, and round-trips the value', async () => {
    const record = await buildStoreItem(
      context(),
      { namespace: ['users', 'u1'], key: 'profile' },
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
      { namespace: ['n'], key: 'k' },
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
   * `rev` is the row's revision token for the compare-and-swap and the id its
   * offloaded value is uploaded under, below the row's own path. A record built
   * without one draws a fresh UUID before the value is encoded, so it still has
   * an object of its own.
   */
  it('uploads the value under the rev it carries onto the record, drawing one when absent', async () => {
    const ctx: StoreContext = {
      ...context(),
      offloader: {
        shouldOffload: () => true,
        buildKey: (parts: readonly string[], objectId: string) => [...parts, objectId].join('/'),
        upload: (key: string) => key,
      } as never,
    };
    const build = (rev?: string) =>
      buildStoreItem(
        ctx,
        { namespace: ['n'], key: 'k' },
        { a: 1 },
        { createdAt: 'c', updatedAt: 'u', rev },
      );
    const keyOf = (record: { value: object }) => (record.value as { s3Key: string }).s3Key;

    const withRev = await build('abc');
    const first = await build();
    const second = await build();

    expect(withRev.rev).toBe('abc');
    expect(keyOf(withRev)).toBe('n/k/abc');
    expect(first.rev).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(keyOf(first)).toBe(`n/k/${first.rev}`);
    expect(second.rev).not.toBe(first.rev);
    expect(keyOf(second)).toBe(`n/k/${second.rev}`);
  });
});

describe('narrowStoreRecord key consistency', () => {
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

  /** The binding is judged under this release's rules, so only for a row it can read. */
  it('still rejects a mismatched row stamped with a version it reads', () => {
    expect(narrowStoreRecord(row({ namespace: ['tenantB', 'u1'], v: 1 }))).toBeUndefined();
  });
});

describe('narrowStoreRecord refuses a row from a newer format version', () => {
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
    expect(narrowStoreRecord({ ...row, v: 1 })).toBeDefined();
  });

  /** Skipping it would hide an item that exists, so it fails loudly. */
  it('throws FORMAT_UNSUPPORTED rather than hiding a newer row', () => {
    expect(() => narrowStoreRecord({ ...row, v: 99 })).toThrow(/format version 99/);
  });

  /**
   * The version is read before the shape, so a row a newer release wrote is
   * reported as newer even when its attributes are not ones this release would
   * accept — a later format may compose the key from attributes this one does
   * not know, and hiding the row because of that is how a `get` answers `null`
   * for an item that exists.
   */
  it('reports a newer row whose attributes disagree with its key', () => {
    expect(() => narrowStoreRecord({ ...row, key: 'other', v: 99 })).toThrow(
      expect.objectContaining({
        code: ErrorCode.FORMAT_UNSUPPORTED,
        context: { field: 'v' },
      }),
    );
  });

  /**
   * A row carrying none of this release's store attributes is exactly the row
   * a later format's renaming produces, so the version decides it: above this
   * reader it is reported, at or below it is the foreign row the narrow exists
   * to skip. The second half is what keeps one hand-written row on a shared
   * table from costing a read every item beside it.
   */
  it('reports a newer row that carries no store attributes at all', () => {
    expect(() => narrowStoreRecord({ PK: 'STORE#n', SK: 'k', v: 99 })).toThrow(
      expect.objectContaining({ code: ErrorCode.FORMAT_UNSUPPORTED }),
    );
    expect(narrowStoreRecord({ PK: 'STORE#n', SK: 'k', v: 1 })).toBeUndefined();
  });
});

describe('buildStoreItem stamps the row format version', () => {
  it('writes v on every item', async () => {
    const record = await buildStoreItem(
      { serde: JSON_SERDE } as never,
      { namespace: ['n'], key: 'k' },
      { a: 1 },
      { createdAt: 'c', updatedAt: 'u' },
    );
    expect(record.v).toBe(1);
  });
});
