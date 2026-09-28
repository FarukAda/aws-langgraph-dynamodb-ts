import { GetCommand } from '@aws-sdk/lib-dynamodb';

import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { buildS3Key, assertKeyInScope } from '../../../../src/shared/codec/s3/config';
import { DynamoDBLangGraphError } from '../../../../src/shared/errors/base-error';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { getItem } from '../../../../src/store/internal/get-item';
import { parseStoreAddress } from '../../../../src/store/internal/parse';
import { buildStoreRow } from '../../../../src/store/internal/rows';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function context(client: StoreContext['client']): StoreContext {
  return {
    client,
    tableName: 'store',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    maxSearchCandidates: 1000,
    maxScanItems: 10000,
    vectorScoreDirection: 'relevance',
  };
}

describe('getItem', () => {
  it('returns null when the item is absent', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    expect(
      await getItem(context(client), parseStoreAddress(['users', 'u1'], 'profile')),
    ).toBeNull();
  });

  it('returns null and warns for a row that is not a store item', async () => {
    // A WRITE row from the checkpointer carries a `value` PayloadDescriptor in
    // the identical shape a store item uses, so an unchecked cast used to
    // decode it successfully and hand another thread's pending write back as
    // the caller's own value.
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({
      Item: {
        PK: 'STORE#users',
        SK: 'u1#profile',
        taskId: 'task-1',
        channel: 'secret-channel',
        value: { location: 'INLINE', serdeType: 'json', bytes: new Uint8Array() },
      },
    });
    const warn = jest.fn();
    const ctx = { ...context(client), logger: { ...SILENT_LOGGER, warn } };
    await expect(getItem(ctx, parseStoreAddress(['users', 'u1'], 'profile'))).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns the decoded item with namespace, key, value, and dates', async () => {
    const { client, mock } = createStrictDocumentMock();
    const record = await buildStoreRow(
      context(client),
      { namespace: ['users', 'u1'], key: 'profile' },
      { name: 'Faruk' },
      {
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
      },
    );
    mock.on(GetCommand).resolves({ Item: record });
    const item = await getItem(context(client), parseStoreAddress(['users', 'u1'], 'profile'));
    expect(item?.value).toEqual({ name: 'Faruk' });
    expect(item?.key).toBe('profile');
    expect(item?.namespace).toEqual(['users', 'u1']);
    expect(mock.commandCalls(GetCommand)[0].args[0].input.Key).toEqual({
      PK: 'STORE#users',
      SK: 'u1#profile',
    });
    expect(mock.commandCalls(GetCommand)[0].args[0].input.ConsistentRead).toBe(true);
  });
});

describe('getItem racing a concurrent overwrite', () => {
  const timestamps = {
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
  };

  function s3Failure(causeName: string): Error {
    return new DynamoDBLangGraphError(
      's3 failed',
      ErrorCode.S3_OFFLOAD_FAILED,
      {},
      Object.assign(new Error(causeName), { name: causeName }),
    );
  }

  /**
   * An offloader whose downloads are answered per S3 key. `downloads` is filled
   * after the records are built, because a key ends in the id of the put that
   * uploaded it and is only known once the record exists.
   */
  function offloaderFor(downloads: Record<string, () => Promise<Uint8Array>>) {
    return {
      shouldOffload: () => true,
      buildKey: (parts: readonly string[], objectId: string) => [...parts, objectId].join('/'),
      upload: (key: string) => key,
      download: jest.fn(async (key: string) => downloads[key]()),
      assertOwnedKey: () => undefined,
      deleteBatch: jest.fn(),
    };
  }

  /** The S3 key a built record's value descriptor points at. */
  function keyOf(record: Awaited<ReturnType<typeof buildStoreRow>>): string {
    return (record.value as { s3Key: string }).s3Key;
  }

  /**
   * `downloads[key]` is typed `() => Promise<Uint8Array>`; both fakes below
   * are synchronous and neither needs `async`: `gone` throws synchronously,
   * which still rejects the `Promise<Uint8Array>` a caller awaits, and
   * `fresh` returns `Promise.resolve(...)`, which already has that type.
   */
  const gone = (): Promise<Uint8Array> => {
    throw s3Failure('NoSuchKey');
  };
  const fresh = (): Promise<Uint8Array> =>
    Promise.resolve(new TextEncoder().encode(JSON.stringify({ name: 'fresh' })));

  /** Without s3:ListBucket, S3 reports the released object as 403 rather than 404. */
  const refused = (): Promise<Uint8Array> => {
    throw s3Failure('AccessDenied');
  };

  async function records(ctx: StoreContext) {
    const old = await buildStoreRow(
      ctx,
      { namespace: ['users', 'u1'], key: 'p' },
      { name: 'old' },
      { ...timestamps, rev: 'A' },
    );
    const replaced = await buildStoreRow(
      ctx,
      { namespace: ['users', 'u1'], key: 'p' },
      { name: 'new' },
      { ...timestamps, rev: 'B' },
    );
    return { old, replaced };
  }

  /**
   * An overwrite stores different bytes, so it writes a different key and the
   * superseded object is the one deleted. A reader holding the old row then
   * finds its object gone — the race this re-read exists for.
   */
  it('re-reads the row once and returns the new value when the first object was deleted by an overwrite', async () => {
    const { client, mock } = createStrictDocumentMock();
    const downloads: Record<string, () => Promise<Uint8Array>> = {};
    const ctx = { ...context(client), offloader: offloaderFor(downloads) as never };
    const { old, replaced } = await records(ctx);
    downloads[keyOf(old)] = gone;
    downloads[keyOf(replaced)] = fresh;
    mock.on(GetCommand).resolvesOnce({ Item: old }).resolvesOnce({ Item: replaced });
    const item = await getItem(ctx, parseStoreAddress(['users', 'u1'], 'p'));
    expect(item?.value).toEqual({ name: 'fresh' });
    expect(mock.commandCalls(GetCommand)).toHaveLength(2);
  });

  it('returns null when the re-read finds the row deleted', async () => {
    const { client, mock } = createStrictDocumentMock();
    const downloads: Record<string, () => Promise<Uint8Array>> = {};
    const ctx = { ...context(client), offloader: offloaderFor(downloads) as never };
    const { old } = await records(ctx);
    downloads[keyOf(old)] = gone;
    mock.on(GetCommand).resolvesOnce({ Item: old }).resolvesOnce({});
    await expect(getItem(ctx, parseStoreAddress(['users', 'u1'], 'p'))).resolves.toBeNull();
  });

  it('rethrows when the re-read still points at the missing object (a genuine loss)', async () => {
    const { client, mock } = createStrictDocumentMock();
    const downloads: Record<string, () => Promise<Uint8Array>> = {};
    const ctx = { ...context(client), offloader: offloaderFor(downloads) as never };
    const { old } = await records(ctx);
    downloads[keyOf(old)] = gone;
    mock.on(GetCommand).resolves({ Item: old });
    await expect(getItem(ctx, parseStoreAddress(['users', 'u1'], 'p'))).rejects.toMatchObject({
      code: ErrorCode.S3_OFFLOAD_FAILED,
    });
    expect(mock.commandCalls(GetCommand)).toHaveLength(2);
  });

  /**
   * The overwrite this re-read exists to catch can put anything on the row,
   * including a `null` where the descriptor was. Comparing the two rows read
   * `location` off it, so the caller of a public `get` was handed a bare
   * TypeError about a property instead of a coded error naming the row's own
   * unreadable descriptor.
   */
  it('answers a re-read row whose descriptor is null with a coded error, not a property read', async () => {
    const { client, mock } = createStrictDocumentMock();
    const downloads: Record<string, () => Promise<Uint8Array>> = {};
    const ctx = { ...context(client), offloader: offloaderFor(downloads) as never };
    const { old } = await records(ctx);
    downloads[keyOf(old)] = gone;
    mock
      .on(GetCommand)
      .resolvesOnce({ Item: old })
      .resolvesOnce({ Item: { ...old, value: null } });
    const error = await getItem(ctx, parseStoreAddress(['users', 'u1'], 'p')).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DynamoDBLangGraphError);
    expect(error).toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'descriptor' } });
  });

  it('does not re-read for a failure that is not a missing object', async () => {
    const { client, mock } = createStrictDocumentMock();
    /** Same reasoning as `gone` above: `downloads[key]` is `Promise<Uint8Array>`. */
    const throttled = (): Promise<Uint8Array> => {
      throw s3Failure('SlowDown');
    };
    const downloads: Record<string, () => Promise<Uint8Array>> = {};
    const ctx = { ...context(client), offloader: offloaderFor(downloads) as never };
    const { old } = await records(ctx);
    downloads[keyOf(old)] = throttled;
    mock.on(GetCommand).resolves({ Item: old });
    await expect(getItem(ctx, parseStoreAddress(['users', 'u1'], 'p'))).rejects.toMatchObject({
      code: ErrorCode.S3_OFFLOAD_FAILED,
    });
    expect(mock.commandCalls(GetCommand)).toHaveLength(1);
  });

  it('re-reads the row when the download is refused, as S3 answers a released object without s3:ListBucket', async () => {
    const { client, mock } = createStrictDocumentMock();
    const downloads: Record<string, () => Promise<Uint8Array>> = {};
    const ctx = { ...context(client), offloader: offloaderFor(downloads) as never };
    const { old, replaced } = await records(ctx);
    downloads[keyOf(old)] = refused;
    downloads[keyOf(replaced)] = fresh;
    mock.on(GetCommand).resolvesOnce({ Item: old }).resolvesOnce({ Item: replaced });
    const item = await getItem(ctx, parseStoreAddress(['users', 'u1'], 'p'));
    expect(item?.value).toEqual({ name: 'fresh' });
  });

  it('rethrows a refused download when the re-read finds the same row, a real permission failure', async () => {
    const { client, mock } = createStrictDocumentMock();
    const downloads: Record<string, () => Promise<Uint8Array>> = {};
    const ctx = { ...context(client), offloader: offloaderFor(downloads) as never };
    const { old } = await records(ctx);
    downloads[keyOf(old)] = refused;
    mock.on(GetCommand).resolves({ Item: old });
    await expect(getItem(ctx, parseStoreAddress(['users', 'u1'], 'p'))).rejects.toMatchObject({
      code: ErrorCode.S3_OFFLOAD_FAILED,
    });
    expect(mock.commandCalls(GetCommand)).toHaveLength(2);
  });
});

describe('getItem S3 key binding', () => {
  it("refuses to download a value whose key lies outside the item's own namespace/key path", async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({
      Item: {
        PK: 'STORE#users',
        SK: 'u1#profile',
        namespace: ['users', 'u1'],
        key: 'profile',
        createdAt: 'c',
        updatedAt: 'u',
        value: {
          location: PayloadLocation.S3,
          serdeType: 'json',
          compressed: false,
          s3Key: buildS3Key('p/', ['victims', 'v1', 'secret'], '01J9ZQ5X3N8VQ4M6C2T7R0K1HD'),
        },
      },
    });
    const offloader = {
      download: jest.fn(),
      assertOwnedKey: (key: string, scope: readonly string[]) => assertKeyInScope(key, 'p/', scope),
    };
    await expect(
      getItem(
        { ...context(client), offloader: offloader as never },
        parseStoreAddress(['users', 'u1'], 'profile'),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 's3Key' } });
    expect(offloader.download).not.toHaveBeenCalled();
  });
});
