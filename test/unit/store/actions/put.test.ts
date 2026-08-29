import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { PutOperation } from '@langchain/langgraph-checkpoint';

import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { putItem } from '../../../../src/store/actions/put';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function context(client: StoreContext['client'], extra?: Partial<StoreContext>): StoreContext {
  return {
    client,
    tableName: 'store',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    maxSearchCandidates: 1000,
    maxScanItems: 10000,
    vectorScoreDirection: 'relevance',
    ...extra,
  };
}
const op = (over: Partial<PutOperation>): PutOperation => ({
  namespace: ['users', 'u1'],
  key: 'profile',
  value: { name: 'Faruk' },
  ...over,
});

function trackingOffloader(
  overrides: {
    shouldOffload?: boolean;
    buildKey?: (parts: string[]) => string;
    upload?: (key: string) => Promise<string>;
  } = {},
) {
  return {
    shouldOffload: () => overrides.shouldOffload ?? true,
    buildKey: overrides.buildKey ?? ((parts: string[]) => parts.join('/')),
    upload: overrides.upload ?? (async (key: string) => key),
    deleteBatch: jest.fn().mockResolvedValue([]),
  };
}
const binKey = (parts: string[]): string => parts.join('/') + '.bin';

describe('putItem', () => {
  it('writes a new item, defaulting createdAt to now', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    await putItem(context(client), op({}));
    const item = mock.commandCalls(PutCommand)[0].args[0].input.Item!;
    expect(item.PK).toBe('STORE#users');
    expect(item.SK).toBe('u1#profile');
    expect(item.createdAt).toBe(item.updatedAt);
    expect(item.embedding).toBeUndefined();
  });

  it('preserves createdAt across updates', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { createdAt: '2000-01-01T00:00:00.000Z' } });
    mock.on(PutCommand).resolves({});
    await putItem(context(client), op({}));
    const item = mock.commandCalls(PutCommand)[0].args[0].input.Item!;
    expect(item.createdAt).toBe('2000-01-01T00:00:00.000Z');
    expect(item.updatedAt).not.toBe(item.createdAt);
  });

  it('deletes when value is null', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(DeleteCommand).resolves({});
    await putItem(context(client), op({ value: null }));
    expect(mock.commandCalls(DeleteCommand)[0].args[0].input.Key).toEqual({
      PK: 'STORE#users',
      SK: 'u1#profile',
    });
  });

  it('rejects an invalid namespace element', async () => {
    const { client } = createStrictDocumentMock();
    try {
      await putItem(context(client), op({ namespace: ['a#b'] }));
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { code: ErrorCode }).code).toBe(ErrorCode.VALIDATION);
    }
  });

  it('computes an embedding when an index is configured', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([0.1, 0.2]) };
    await putItem(context(client, { index: { dims: 2, embeddings: embeddings as never } }), op({}));
    expect(mock.commandCalls(PutCommand)[0].args[0].input.Item!.embedding).toEqual([0.1, 0.2]);
  });

  it('skips embedding when index is false for the item', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    const embeddings = { embedQuery: jest.fn() };
    await putItem(
      context(client, { index: { dims: 2, embeddings: embeddings as never } }),
      op({ index: false }),
    );
    expect(embeddings.embedQuery).not.toHaveBeenCalled();
    expect(mock.commandCalls(PutCommand)[0].args[0].input.Item!.embedding).toBeUndefined();
  });

  it('uses a per-item index field override', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([1, 2]) };
    await putItem(
      context(client, { index: { dims: 2, embeddings: embeddings as never } }),
      op({ value: { name: 'Faruk', bio: 'builds things' }, index: ['bio'] }),
    );
    expect(embeddings.embedQuery).toHaveBeenCalledWith('builds things');
  });

  it('rethrows a write failure without cleanup when no offloader is set', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).rejects(Object.assign(new Error('down'), { name: 'ValidationException' }));
    await expect(putItem(context(client), op({}))).rejects.toThrow('down');
  });

  it('stamps ttl when configured', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    await putItem(context(client, { ttl: { seconds: 100 } }), op({}));
    expect(typeof mock.commandCalls(PutCommand)[0].args[0].input.Item!.ttl).toBe('number');
  });

  it('cleans up offloaded objects when the write fails', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).rejects(Object.assign(new Error('boom'), { name: 'ValidationException' }));
    const offloader = trackingOffloader();
    await expect(
      putItem(context(client, { offloader: offloader as never }), op({})),
    ).rejects.toThrow('boom');
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
    const [keys] = offloader.deleteBatch.mock.calls[0] as [string[]];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^users\/u1\/profile\//);
  });

  // Integration-level: prove persistRecord wires verifyWriteLanded's landed/not-landed/unverified verdict correctly into the delete/rethrow decision (its own branches are unit-tested in write-verify.test.ts).
  it('does not delete the new S3 object, and succeeds, when an ambiguous retry-exhaustion write actually landed', async () => {
    const { client, mock } = createStrictDocumentMock();
    let uploadedKey = '';
    mock.on(GetCommand).callsFake(async () =>
      uploadedKey
        ? {
            Item: {
              value: {
                location: PayloadLocation.S3,
                serdeType: 'json',
                compressed: false,
                s3Key: uploadedKey,
              },
            },
          }
        : {},
    );
    mock.on(PutCommand).rejects(Object.assign(new Error('timeout'), { name: 'ETIMEDOUT' }));
    const offloader = trackingOffloader({
      upload: async (key: string) => {
        uploadedKey = key;
        return key;
      },
    });
    const ctx = context(client, { offloader: offloader as never });
    await expect(putItem(ctx, op({}))).resolves.toBeUndefined();
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
  });

  it('cleans up the new S3 object and rethrows when an ambiguous retry-exhaustion write genuinely did not land', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).rejects(Object.assign(new Error('timeout'), { name: 'ETIMEDOUT' }));
    const offloader = trackingOffloader();
    const ctx = context(client, { offloader: offloader as never });
    await expect(putItem(ctx, op({}))).rejects.toThrow('timeout');
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
  });

  it('reads createdAt and the previous value descriptor in a single GetItem call', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({
      Item: {
        createdAt: '2000-01-01T00:00:00.000Z',
        value: {
          location: PayloadLocation.INLINE,
          serdeType: 'json',
          compressed: false,
          bytes: new Uint8Array(),
        },
      },
    });
    mock.on(PutCommand).resolves({});
    await putItem(context(client), op({}));
    expect(mock.commandCalls(GetCommand)).toHaveLength(1);
    expect(mock.commandCalls(GetCommand)[0].args[0].input.ProjectionExpression).toBe('#c, #v, #r');
  });

  it('offloads each successful put to a distinct S3 key (nonced, not deterministic)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    const uploaded: string[] = [];
    const offloader = trackingOffloader({
      upload: async (key: string) => {
        uploaded.push(key);
        return key;
      },
    });
    await putItem(context(client, { offloader: offloader as never }), op({}));
    await putItem(context(client, { offloader: offloader as never }), op({}));
    expect(uploaded[0]).not.toBe(uploaded[1]);
  });

  it('does NOT delete the previous S3 object when an overwrite put fails (regression: this was the data-loss bug)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({
      Item: {
        createdAt: '2000-01-01T00:00:00.000Z',
        value: {
          location: PayloadLocation.S3,
          serdeType: 'json',
          compressed: false,
          s3Key: 'old-key.bin',
        },
      },
    });
    mock.on(PutCommand).rejects(Object.assign(new Error('boom'), { name: 'ValidationException' }));
    const offloader = trackingOffloader({ buildKey: binKey });
    await expect(
      putItem(context(client, { offloader: offloader as never }), op({})),
    ).rejects.toThrow('boom');
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
    const [keys] = offloader.deleteBatch.mock.calls[0] as [string[]];
    expect(keys).not.toContain('old-key.bin');
  });

  it('cleans up the previous S3 object after a successful overwrite', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({
      Item: {
        createdAt: '2000-01-01T00:00:00.000Z',
        value: {
          location: PayloadLocation.S3,
          serdeType: 'json',
          compressed: false,
          s3Key: 'old-key.bin',
        },
      },
    });
    mock.on(PutCommand).resolves({});
    const offloader = trackingOffloader({ buildKey: binKey });
    await putItem(context(client, { offloader: offloader as never }), op({}));
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['old-key.bin']);
  });

  it('cleans up the previous S3 object when a large value is overwritten by a small inline one', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({
      Item: {
        createdAt: '2000-01-01T00:00:00.000Z',
        value: {
          location: PayloadLocation.S3,
          serdeType: 'json',
          compressed: false,
          s3Key: 'old-key.bin',
        },
      },
    });
    mock.on(PutCommand).resolves({});
    const offloader = trackingOffloader({ shouldOffload: false, buildKey: binKey });
    await putItem(context(client, { offloader: offloader as never }), op({}));
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['old-key.bin']);
  });

  it('sends the embedding to a vector backend instead of storing it on the item', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([0.5, 0.6]) };
    const vectorBackend = { upsert: jest.fn(), query: jest.fn(), delete: jest.fn() };
    await putItem(
      context(client, {
        index: { dims: 2, embeddings: embeddings as never },
        vectorBackend: vectorBackend as never,
      }),
      op({}),
    );
    expect(mock.commandCalls(PutCommand)[0].args[0].input.Item!.embedding).toBeUndefined();
    expect(vectorBackend.upsert).toHaveBeenCalledWith(['users', 'u1'], 'profile', [0.5, 0.6]);
  });

  it('removes the backend vector when a re-put yields no embedding (index:false)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { createdAt: '2000-01-01T00:00:00.000Z' } });
    mock.on(PutCommand).resolves({});
    const embeddings = { embedQuery: jest.fn() };
    const vectorBackend = { upsert: jest.fn(), query: jest.fn(), delete: jest.fn() };
    await putItem(
      context(client, {
        index: { dims: 2, embeddings: embeddings as never },
        vectorBackend: vectorBackend as never,
      }),
      op({ index: false }),
    );
    expect(vectorBackend.upsert).not.toHaveBeenCalled();
    expect(vectorBackend.delete).toHaveBeenCalledWith(['users', 'u1'], 'profile');
  });

  it('deletes from the vector backend when removing an item', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(DeleteCommand).resolves({});
    const vectorBackend = { upsert: jest.fn(), query: jest.fn(), delete: jest.fn() };
    await putItem(context(client, { vectorBackend: vectorBackend as never }), op({ value: null }));
    expect(vectorBackend.delete).toHaveBeenCalledWith(['users', 'u1'], 'profile');
  });

  it('does not fail a put when the vector backend upsert throws', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([0.5, 0.6]) };
    const vectorBackend = {
      upsert: jest.fn().mockRejectedValue(new Error('backend down')),
      query: jest.fn(),
      delete: jest.fn(),
    };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const ctx = context(client, {
      index: { dims: 2, embeddings: embeddings as never },
      vectorBackend: vectorBackend as never,
      logger,
    });
    await expect(putItem(ctx, op({}))).resolves.toBeUndefined();
    expect(mock.commandCalls(PutCommand)).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('vector-index sync failed'),
      expect.objectContaining({ key: 'profile' }),
    );
  });

  it('does not fail a delete when the vector backend delete throws', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(DeleteCommand).resolves({});
    const vectorBackend = {
      upsert: jest.fn(),
      query: jest.fn(),
      delete: jest.fn().mockRejectedValue(new Error('backend down')),
    };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const ctx = context(client, { vectorBackend: vectorBackend as never, logger });
    await expect(putItem(ctx, op({ value: null }))).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('cleans up the offloaded S3 object when a large value is deleted', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({
      Item: {
        value: { location: PayloadLocation.S3, serdeType: 'json', s3Key: 'users/u1/profile.bin' },
      },
    });
    mock.on(DeleteCommand).resolves({});
    const offloader = trackingOffloader();
    await putItem(context(client, { offloader: offloader as never }), op({ value: null }));
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['users/u1/profile.bin']);
  });

  it('does not attempt S3 cleanup on delete when no offloader is configured', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(DeleteCommand).resolves({});
    await putItem(context(client), op({ value: null }));
    expect(mock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('does not call deleteBatch when offloader is configured but no descriptor found', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(DeleteCommand).resolves({});
    const offloader = trackingOffloader();
    await putItem(context(client, { offloader: offloader as never }), op({ value: null }));
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
  });
});
