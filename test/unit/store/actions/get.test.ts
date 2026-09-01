import { GetCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { DynamoDbLangGraphError } from '../../../../src/shared/errors/base-error';
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
    return new DynamoDbLangGraphError(
      's3 failed',
      ErrorCode.S3_OFFLOAD_FAILED,
      {},
      Object.assign(new Error(causeName), { name: causeName }),
    );
  }

  /** An offloader whose downloads are answered per S3 key. */
  function offloaderFor(downloads: Record<string, () => Promise<Uint8Array>>) {
    return {
      shouldOffload: () => true,
      buildKey: (parts: readonly string[]) => parts.join('/'),
      upload: async (key: string) => key,
      download: jest.fn(async (key: string) => downloads[key]()),
      deleteBatch: jest.fn(),
    };
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
      { ...timestamps, nonce: 'A' },
    );
    const replaced = await buildStoreItem(
      ctx,
      ['users', 'u1'],
      'p',
      { name: 'new' },
      { ...timestamps, nonce: 'B' },
    );
    return { old, replaced };
  }

  it('re-reads the row once and returns the new value when the first object was deleted by an overwrite', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = {
      ...context(client),
      offloader: offloaderFor({ 'users/u1/p/A': gone, 'users/u1/p/B': fresh }) as never,
    };
    const { old, replaced } = await records(ctx);
    mock.on(GetCommand).resolvesOnce({ Item: old }).resolvesOnce({ Item: replaced });
    const item = await getItem(ctx, ['users', 'u1'], 'p');
    expect(item?.value).toEqual({ name: 'fresh' });
    expect(mock.commandCalls(GetCommand)).toHaveLength(2);
  });

  it('returns null when the re-read finds the row deleted', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = { ...context(client), offloader: offloaderFor({ 'users/u1/p/A': gone }) as never };
    const { old } = await records(ctx);
    mock.on(GetCommand).resolvesOnce({ Item: old }).resolvesOnce({});
    await expect(getItem(ctx, ['users', 'u1'], 'p')).resolves.toBeNull();
  });

  it('rethrows when the re-read still points at the missing object (a genuine loss)', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = { ...context(client), offloader: offloaderFor({ 'users/u1/p/A': gone }) as never };
    const { old } = await records(ctx);
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
    const ctx = {
      ...context(client),
      offloader: offloaderFor({ 'users/u1/p/A': throttled }) as never,
    };
    const { old } = await records(ctx);
    mock.on(GetCommand).resolves({ Item: old });
    await expect(getItem(ctx, ['users', 'u1'], 'p')).rejects.toMatchObject({
      code: ErrorCode.S3_OFFLOAD_FAILED,
    });
    expect(mock.commandCalls(GetCommand)).toHaveLength(1);
  });
});
