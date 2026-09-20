import { DeleteCommand, GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { PutOperation } from '@langchain/langgraph-checkpoint';

import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { putItem } from '../../../../src/store/actions/put';
import { buildStoreItem } from '../../../../src/store/internal/item-mapper';
import type { StoreContext } from '../../../../src/store/internal/setup';
import {
  committedRows,
  createStrictDocumentMock,
  rejectRowWrites,
  resolveRowWrites,
} from '../../../shared/helpers/ddb-mock';
import { stubEmbeddings } from '../../../shared/helpers/embeddings-stub';

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
    buildKey?: (parts: string[], objectId: string) => string;
    upload?: (key: string) => Promise<string>;
  } = {},
) {
  return {
    shouldOffload: () => overrides.shouldOffload ?? true,
    buildKey:
      overrides.buildKey ?? ((parts: string[], objectId: string) => [...parts, objectId].join('/')),
    upload: overrides.upload ?? (async (key: string) => key),
    deleteBatch: jest.fn().mockResolvedValue([]),
    ownsKey: () => true,
  };
}
/** The single item an offloaded row write wraps in its transaction. */
interface TransactPut {
  Put: { Item: Record<string, unknown> };
}

const binKey = (parts: string[], objectId: string): string =>
  [...parts, objectId].join('/') + '.bin';

/** Answer `readExisting` with a row whose value is offloaded at `old-key.bin`. */
function answerExisting(mock: ReturnType<typeof createStrictDocumentMock>['mock']): void {
  const previous = { location: PayloadLocation.S3, serdeType: 'json', s3Key: 'old-key.bin' };
  mock
    .on(GetCommand)
    .resolves({ Item: { createdAt: '2000-01-01T00:00:00.000Z', rev: 'r0', value: previous } });
}

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

  /**
   * One vector per extracted path, scored by best match on read, as the
   * reference store does. A single joined vector averaged a long document into
   * one point and buried a strongly-matching section.
   */
  it('stores one vector per extracted path when an index is configured', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    const embeddings = stubEmbeddings([0.1, 0.2]);
    await putItem(context(client, { index: { dims: 2, embeddings: embeddings as never } }), op({}));
    expect(mock.commandCalls(PutCommand)[0].args[0].input.Item!.embeddings).toEqual([[0.1, 0.2]]);
  });

  it('skips embedding when index is false for the item', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    const embeddings = { embedQuery: jest.fn(), embedDocuments: jest.fn() };
    await putItem(
      context(client, { index: { dims: 2, embeddings: embeddings as never } }),
      op({ index: false }),
    );
    expect(embeddings.embedDocuments).not.toHaveBeenCalled();
    expect(mock.commandCalls(PutCommand)[0].args[0].input.Item!.embedding).toBeUndefined();
  });

  it('uses a per-item index field override', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    const embeddings = stubEmbeddings([1, 2]);
    await putItem(
      context(client, { index: { dims: 2, embeddings: embeddings as never } }),
      op({ value: { name: 'Faruk', bio: 'builds things' }, index: ['bio'] }),
    );
    expect(embeddings.embedDocuments).toHaveBeenCalledWith(['builds things']);
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
    rejectRowWrites(mock, Object.assign(new Error('boom'), { name: 'ValidationException' }));
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
    let rev: string | undefined;
    mock.on(GetCommand).callsFake(async () => (rev ? { Item: { rev } } : {}));
    mock.on(TransactWriteCommand).callsFake((input: { TransactItems: TransactPut[] }) => {
      rev = input.TransactItems[0].Put.Item.rev as string;
      throw Object.assign(new Error('timeout'), { name: 'ETIMEDOUT' });
    });
    const offloader = trackingOffloader();
    const ctx = context(client, { offloader: offloader as never });
    await expect(putItem(ctx, op({}))).resolves.toBeUndefined();
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
  });
  it('cleans up the new S3 object and rethrows when an ambiguous retry-exhaustion write genuinely did not land', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    rejectRowWrites(mock, Object.assign(new Error('timeout'), { name: 'ETIMEDOUT' }));
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
    const read = mock.commandCalls(GetCommand)[0].args[0].input;
    expect(read.ProjectionExpression).toBe('#c, #r, #v.#loc, #v.#s3k');
    expect(read.ExpressionAttributeNames).toMatchObject({ '#loc': 'location', '#s3k': 's3Key' });
  });

  /**
   * Every put uploads under its own `rev`, identical value or not, so no two
   * puts ever address one object and each row names only its own put's.
   */
  it("offloads every put to a key of its own, ending in that put's rev", async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    resolveRowWrites(mock);
    const uploaded: string[] = [];
    const offloader = trackingOffloader({
      upload: async (key: string) => {
        uploaded.push(key);
        return key;
      },
    });
    const ctx = context(client, { offloader: offloader as never });
    await putItem(ctx, op({}));
    await putItem(ctx, op({}));
    await putItem(ctx, op({ value: { name: 'someone else' } }));
    const revs = committedRows(mock).map((row) => row.rev);
    expect(uploaded).toEqual(revs.map((rev) => `users/u1/profile/${rev}`));
    expect(new Set(uploaded).size).toBe(3);
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
    rejectRowWrites(mock, Object.assign(new Error('boom'), { name: 'ValidationException' }));
    const offloader = trackingOffloader({ buildKey: binKey });
    await expect(
      putItem(context(client, { offloader: offloader as never }), op({})),
    ).rejects.toThrow('boom');
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
    const [keys] = offloader.deleteBatch.mock.calls[0] as [string[]];
    expect(keys).not.toContain('old-key.bin');
  });

  /**
   * Re-putting the same value uploads under the new put's own `rev`, so the
   * superseded object and the one the surviving row names are two objects, and
   * releasing the first never touches the second.
   */
  it('releases the superseded object, never the one the surviving row names (identical re-put)', async () => {
    const { client, mock } = createStrictDocumentMock();
    const offloader = trackingOffloader({ buildKey: binKey });
    const ctx = context(client, { offloader: offloader as never });
    const first = await buildStoreItem(ctx, ['users', 'u1'], 'profile', op({}).value as never, {
      createdAt: 'c',
      updatedAt: 'u',
      rev: 'A',
    });
    mock.on(GetCommand).resolves({ Item: first });
    resolveRowWrites(mock);

    await putItem(ctx, op({}));

    const surviving = committedRows(mock)[0].value as { s3Key: string };
    expect(surviving.s3Key).not.toBe((first.value as { s3Key: string }).s3Key);
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
    expect(offloader.deleteBatch).toHaveBeenCalledWith([(first.value as { s3Key: string }).s3Key]);
  });

  /**
   * The other side: a confirmed non-commit releases its own upload, and the row
   * that survived names the earlier put's object, a different one even when the
   * bytes are unchanged.
   */
  it("releases only its own upload, never the surviving previous row's object (identical re-put)", async () => {
    const { client, mock } = createStrictDocumentMock();
    const offloader = trackingOffloader({ buildKey: binKey });
    const ctx = context(client, { offloader: offloader as never });
    const first = await buildStoreItem(ctx, ['users', 'u1'], 'profile', op({}).value as never, {
      createdAt: 'c',
      updatedAt: 'u',
      rev: 'A',
    });
    mock.on(GetCommand).resolves({ Item: first });
    rejectRowWrites(mock, Object.assign(new Error('boom'), { name: 'ValidationException' }));

    await expect(putItem(ctx, op({}))).rejects.toThrow('boom');

    const own = committedRows(mock)[0].value as { s3Key: string };
    expect(own.s3Key).not.toBe((first.value as { s3Key: string }).s3Key);
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
    expect(offloader.deleteBatch).toHaveBeenCalledWith([own.s3Key]);
  });

  it('cleans up the previous S3 object after a successful overwrite', async () => {
    const { client, mock } = createStrictDocumentMock();
    answerExisting(mock);
    resolveRowWrites(mock);
    const offloader = trackingOffloader({ buildKey: binKey });
    await putItem(context(client, { offloader: offloader as never }), op({}));
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['old-key.bin']);
    expect(mock.commandCalls(GetCommand)).toHaveLength(1);
  });

  it('cleans up the previous S3 object when a large value is overwritten by a small inline one', async () => {
    const { client, mock } = createStrictDocumentMock();
    answerExisting(mock);
    mock.on(PutCommand).resolves({});
    const offloader = trackingOffloader({ shouldOffload: false, buildKey: binKey });
    await putItem(context(client, { offloader: offloader as never }), op({}));
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['old-key.bin']);
  });

  /**
   * The row is never read: what was removed comes back with the delete, and its
   * object was uploaded under the removed row's own put, which no other put's row
   * names.
   */
  it('cleans up the offloaded object DynamoDB reports as removed, without a pre-read (STORE-08)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(DeleteCommand).resolves({
      Attributes: {
        value: { location: PayloadLocation.S3, serdeType: 'json', s3Key: 'users/u1/profile.bin' },
      },
    });
    mock.on(GetCommand).resolves({});
    const offloader = trackingOffloader();
    await putItem(context(client, { offloader: offloader as never }), op({ value: null }));
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['users/u1/profile.bin']);
    expect(mock.commandCalls(DeleteCommand)[0].args[0].input.ReturnValues).toBe('ALL_OLD');
    expect(mock.commandCalls(GetCommand)).toHaveLength(0);
    expect(mock.calls()).toHaveLength(1);
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
