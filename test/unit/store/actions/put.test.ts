import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { PutOperation } from '@langchain/langgraph-checkpoint';

import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { putItem } from '../../../../src/store/actions/put';
import { buildStoreItem } from '../../../../src/store/internal/item-mapper';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
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
    buildKey?: (parts: string[], hash: string) => string;
    upload?: (key: string) => Promise<string>;
  } = {},
) {
  return {
    shouldOffload: () => overrides.shouldOffload ?? true,
    buildKey: overrides.buildKey ?? ((parts: string[], hash: string) => [...parts, hash].join('/')),
    upload: overrides.upload ?? (async (key: string) => key),
    deleteBatch: jest.fn().mockResolvedValue([]),
    ownsKey: () => true,
  };
}
const binKey = (parts: string[], hash: string): string => [...parts, hash].join('/') + '.bin';

/**
 * Answer `readExisting` with a row whose value is offloaded at `old-key.bin`,
 * and the read that follows a committed overwrite with a row holding `live`:
 * the previous object is released only when that row names another.
 */
function answerExistingThenLive(
  mock: ReturnType<typeof createStrictDocumentMock>['mock'],
  live: { location: PayloadLocation; s3Key?: string },
): void {
  const previous = { location: PayloadLocation.S3, serdeType: 'json', s3Key: 'old-key.bin' };
  mock
    .on(GetCommand)
    .callsFake(async (input: { ProjectionExpression: string }) =>
      input.ProjectionExpression.startsWith('#c')
        ? { Item: { createdAt: '2000-01-01T00:00:00.000Z', value: previous } }
        : { Item: { rev: 'r1', value: live } },
    );
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
    let rev: string | undefined;
    mock.on(GetCommand).callsFake(async () => (rev ? { Item: { rev } } : {}));
    mock.on(PutCommand).callsFake((input) => {
      rev = input.Item.rev as string;
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
    const read = mock.commandCalls(GetCommand)[0].args[0].input;
    expect(read.ProjectionExpression).toBe('#c, #r, #v.#loc, #v.#s3k');
    expect(read.ExpressionAttributeNames).toMatchObject({ '#loc': 'location', '#s3k': 's3Key' });
  });

  /**
   * Re-putting the same value addresses the same object, so a retry adds
   * nothing to the bucket. A changed value addresses a different one, which is
   * what lets the overwrite delete exactly the payload it superseded.
   */
  it('offloads identical values to one key and a changed value to another', async () => {
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
    const ctx = context(client, { offloader: offloader as never });
    await putItem(ctx, op({}));
    await putItem(ctx, op({}));
    await putItem(ctx, op({ value: { name: 'someone else' } }));
    expect(uploaded[1]).toBe(uploaded[0]);
    expect(uploaded[2]).not.toBe(uploaded[0]);
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

  /**
   * Re-putting the same value lands on the same content-addressed key, so the
   * "previous" object and the new one are one object. Deleting it after the
   * overwrite would leave the live row pointing at nothing.
   */
  it('never deletes the object the surviving row still points at (identical re-put)', async () => {
    const { client, mock } = createStrictDocumentMock();
    const offloader = trackingOffloader({ buildKey: binKey });
    const ctx = context(client, { offloader: offloader as never });
    const first = await buildStoreItem(ctx, ['users', 'u1'], 'profile', op({}).value as never, {
      createdAt: 'c',
      updatedAt: 'u',
      rev: 'A',
    });
    mock.on(GetCommand).resolves({ Item: first });
    mock.on(PutCommand).resolves({});

    await putItem(ctx, op({}));

    expect(offloader.deleteBatch).not.toHaveBeenCalled();
  });

  /**
   * The same hazard from the other side: a confirmed non-commit deletes its own
   * upload, which is the object the row that survived is still using when the
   * bytes are unchanged.
   */
  it('never deletes its own upload when the surviving previous row shares it', async () => {
    const { client, mock } = createStrictDocumentMock();
    const offloader = trackingOffloader({ buildKey: binKey });
    const ctx = context(client, { offloader: offloader as never });
    const first = await buildStoreItem(ctx, ['users', 'u1'], 'profile', op({}).value as never, {
      createdAt: 'c',
      updatedAt: 'u',
      rev: 'A',
    });
    mock.on(GetCommand).resolves({ Item: first });
    mock.on(PutCommand).rejects(Object.assign(new Error('boom'), { name: 'ValidationException' }));

    await expect(putItem(ctx, op({}))).rejects.toThrow('boom');

    expect(offloader.deleteBatch).not.toHaveBeenCalled();
  });

  it('cleans up the previous S3 object after a successful overwrite', async () => {
    const { client, mock } = createStrictDocumentMock();
    answerExistingThenLive(mock, { location: PayloadLocation.S3, s3Key: 'new-key.bin' });
    mock.on(PutCommand).resolves({});
    const offloader = trackingOffloader({ buildKey: binKey });
    await putItem(context(client, { offloader: offloader as never }), op({}));
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['old-key.bin']);
  });

  it('cleans up the previous S3 object when a large value is overwritten by a small inline one', async () => {
    const { client, mock } = createStrictDocumentMock();
    answerExistingThenLive(mock, { location: PayloadLocation.INLINE });
    mock.on(PutCommand).resolves({});
    const offloader = trackingOffloader({ shouldOffload: false, buildKey: binKey });
    await putItem(context(client, { offloader: offloader as never }), op({}));
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['old-key.bin']);
  });

  /**
   * The row is read once, after the delete and never before it: what was removed
   * comes back with the delete, and the read only asks whether a re-put names it.
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
    expect(mock.commandCalls(GetCommand)).toHaveLength(1);
    expect(mock.calls()[0].args[0]).toBe(mock.commandCalls(DeleteCommand)[0].args[0]);
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
