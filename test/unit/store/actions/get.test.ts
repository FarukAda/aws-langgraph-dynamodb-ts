import { GetCommand } from '@aws-sdk/lib-dynamodb';

import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { buildS3Key } from '../../../../src/shared/codec/s3/config';
import { assertKeyInScope } from '../../../../src/shared/codec/s3/key-scope';
import { DynamoDBLangGraphError } from '../../../../src/shared/errors/base-error';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { ValidationError } from '../../../../src/shared/errors/errors';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { getItem } from '../../../../src/store/actions/get';
import { buildStoreItem } from '../../../../src/store/internal/item-mapper';
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
    expect(await getItem(context(client), ['users', 'u1'], 'profile')).toBeNull();
  });

  it('returns null and warns for a row that is not a store item (C2, I7)', async () => {
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
    await expect(getItem(ctx, ['users', 'u1'], 'profile')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('throws ValidationError on an empty namespace', async () => {
    const { client } = createStrictDocumentMock();
    await expect(getItem(context(client), [], 'k1')).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError when the key contains the reserved separator', async () => {
    const { client } = createStrictDocumentMock();
    await expect(getItem(context(client), ['users'], 'a#b')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('returns the decoded item with namespace, key, value, and dates', async () => {
    const { client, mock } = createStrictDocumentMock();
    const record = await buildStoreItem(
      context(client),
      ['users', 'u1'],
      'profile',
      { name: 'Faruk' },
      {
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
      },
    );
    mock.on(GetCommand).resolves({ Item: record });
    const item = await getItem(context(client), ['users', 'u1'], 'profile');
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

describe('getItem racing a concurrent overwrite (CODEC-03)', () => {
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
      upload: async (key: string) => key,
      download: jest.fn(async (key: string) => downloads[key]()),
      assertOwnedKey: () => undefined,
      deleteBatch: jest.fn(),
    };
  }

  /** The S3 key a built record's value descriptor points at. */
  function keyOf(record: Awaited<ReturnType<typeof buildStoreItem>>): string {
    return (record.value as { s3Key: string }).s3Key;
  }

  const gone = async (): Promise<Uint8Array> => {
    throw s3Failure('NoSuchKey');
  };
  const fresh = async (): Promise<Uint8Array> =>
    new TextEncoder().encode(JSON.stringify({ name: 'fresh' }));

  async function records(ctx: StoreContext) {
    const old = await buildStoreItem(
      ctx,
      ['users', 'u1'],
      'p',
      { name: 'old' },
      { ...timestamps, rev: 'A' },
    );
    const replaced = await buildStoreItem(
      ctx,
      ['users', 'u1'],
      'p',
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
    const item = await getItem(ctx, ['users', 'u1'], 'p');
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
    await expect(getItem(ctx, ['users', 'u1'], 'p')).resolves.toBeNull();
  });

  it('rethrows when the re-read still points at the missing object (a genuine loss)', async () => {
    const { client, mock } = createStrictDocumentMock();
    const downloads: Record<string, () => Promise<Uint8Array>> = {};
    const ctx = { ...context(client), offloader: offloaderFor(downloads) as never };
    const { old } = await records(ctx);
    downloads[keyOf(old)] = gone;
    mock.on(GetCommand).resolves({ Item: old });
    await expect(getItem(ctx, ['users', 'u1'], 'p')).rejects.toMatchObject({
      code: ErrorCode.S3_OFFLOAD_FAILED,
    });
    expect(mock.commandCalls(GetCommand)).toHaveLength(2);
  });

  it('does not re-read for a failure that is not a missing object', async () => {
    const { client, mock } = createStrictDocumentMock();
    const throttled = async (): Promise<Uint8Array> => {
      throw s3Failure('SlowDown');
    };
    const downloads: Record<string, () => Promise<Uint8Array>> = {};
    const ctx = { ...context(client), offloader: offloaderFor(downloads) as never };
    const { old } = await records(ctx);
    downloads[keyOf(old)] = throttled;
    mock.on(GetCommand).resolves({ Item: old });
    await expect(getItem(ctx, ['users', 'u1'], 'p')).rejects.toMatchObject({
      code: ErrorCode.S3_OFFLOAD_FAILED,
    });
    expect(mock.commandCalls(GetCommand)).toHaveLength(1);
  });
});

describe('getItem S3 key binding (SEC-03)', () => {
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
      getItem({ ...context(client), offloader: offloader as never }, ['users', 'u1'], 'profile'),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 's3Key' } });
    expect(offloader.download).not.toHaveBeenCalled();
  });
});
