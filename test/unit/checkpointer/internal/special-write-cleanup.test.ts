import { BatchWriteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { writeSpecialItemsWithCleanup } from '../../../../src/checkpointer/internal/special-write-cleanup';
import type { CheckpointWriteItem } from '../../../../src/checkpointer/types';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const serde = {
  dumpsTyped: async (): Promise<[string, Uint8Array]> => ['json', new Uint8Array()],
  loadsTyped: async (): Promise<unknown> => undefined,
};

function context(client: CheckpointerContext['client']): CheckpointerContext {
  return { client, tableName: 'ckpt', serde, logger: SILENT_LOGGER };
}

/** A pre-built `__error__` write item; the SK matches a real WRITES_IDX_MAP-derived one. */
function specialItem(s3Key: string): CheckpointWriteItem {
  return {
    PK: 't',
    SK: 'WRITE##c1#task-1#0000000007',
    taskId: 'task-1',
    index: -1,
    writeGroup: 'group-1',
    channel: '__error__',
    value: { location: PayloadLocation.S3, serdeType: 'json', compressed: false, s3Key },
  };
}

const oldS3Descriptor = {
  value: { location: PayloadLocation.S3, serdeType: 'json', compressed: false, s3Key: 'old.bin' },
};

function trackingOffloader() {
  return {
    shouldOffload: () => true,
    buildKey: (parts: readonly string[]) => parts.join('/'),
    upload: async (key: string) => key,
    deleteBatch: jest.fn().mockResolvedValue([]),
  };
}

describe('writeSpecialItemsWithCleanup', () => {
  it('cleans up the previous S3 object after a special write successfully overwrites it', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: oldS3Descriptor });
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    const offloader = trackingOffloader();
    const ctx = { ...context(client), offloader: offloader as never };
    const result = await writeSpecialItemsWithCleanup(ctx, [specialItem('new.bin')]);
    expect(result).toBeUndefined();
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['old.bin']);
  });

  it('cleans up only the new upload, not the previous object, when a special write never commits', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: oldS3Descriptor });
    // Always reports this item's own row unprocessed, so drainUnprocessedWrites
    // exhausts its full 10-retry budget (real backoff sleeps) before
    // batchWriteAll throws — intentionally slower than its neighbors, the same
    // disclosed tradeoff as Task 3's ambiguous-retry test in
    // store/actions/put.test.ts.
    mock.on(BatchWriteCommand).resolves({
      UnprocessedItems: {
        ckpt: [{ PutRequest: { Item: { PK: 't', SK: 'WRITE##c1#task-1#0000000007' } } }],
      },
    });
    const offloader = trackingOffloader();
    const ctx = { ...context(client), offloader: offloader as never };
    const result = await writeSpecialItemsWithCleanup(ctx, [specialItem('new.bin')]);
    expect(result).toMatchObject({ name: 'BatchWriteAllIncompleteError' });
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['new.bin']);
  });

  it('returns (never rejects) when reading the previous descriptor fails, without attempting the batch write', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(GetCommand)
      .rejects(Object.assign(new Error('get boom'), { name: 'ValidationException' }));
    const offloader = trackingOffloader();
    const ctx = { ...context(client), offloader: offloader as never };
    const result = await writeSpecialItemsWithCleanup(ctx, [specialItem('new.bin')]);
    // A rejection here (instead of a returned Error) would propagate out of
    // the Promise.all putWrites composes this with, short-circuiting past
    // writeRegularItems's own cleanup for a regular write that failed in the
    // same call — see put-writes.test.ts's composition-level regression test.
    expect(result).toMatchObject({ message: 'get boom' });
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['new.bin']);
  });

  it('is a no-op for an empty items list', async () => {
    const { client, mock } = createStrictDocumentMock();
    const offloader = trackingOffloader();
    const ctx = { ...context(client), offloader: offloader as never };
    const result = await writeSpecialItemsWithCleanup(ctx, []);
    expect(result).toBeUndefined();
    expect(mock.commandCalls(GetCommand)).toHaveLength(0);
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('skips reading the previous descriptor entirely when no offloader is configured', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    const ctx = context(client);
    const result = await writeSpecialItemsWithCleanup(ctx, [specialItem('new.bin')]);
    expect(result).toBeUndefined();
    expect(mock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('splits a mixed batch outcome: cleans up the previous object for the committed item and the new upload for the never-committed item', async () => {
    const { client, mock } = createStrictDocumentMock();
    const committedItem = specialItem('committed-new.bin');
    const neverCommittedItem: CheckpointWriteItem = {
      ...specialItem('never-committed-new.bin'),
      SK: 'WRITE##c1#task-1#0000000008',
    };
    mock
      .on(GetCommand)
      .resolvesOnce({
        Item: {
          value: {
            location: PayloadLocation.S3,
            serdeType: 'json',
            compressed: false,
            s3Key: 'committed-old.bin',
          },
        },
      })
      .resolvesOnce({
        Item: {
          value: {
            location: PayloadLocation.S3,
            serdeType: 'json',
            compressed: false,
            s3Key: 'never-committed-old.bin',
          },
        },
      });
    // Persistently reports only neverCommittedItem's row unprocessed, so
    // drainUnprocessedWrites exhausts its retry budget (real backoff sleeps)
    // before batchWriteAll throws — same disclosed tradeoff as the
    // never-commits test above.
    mock.on(BatchWriteCommand).resolves({
      UnprocessedItems: {
        ckpt: [{ PutRequest: { Item: { PK: 't', SK: neverCommittedItem.SK } } }],
      },
    });
    const offloader = trackingOffloader();
    const ctx = { ...context(client), offloader: offloader as never };
    const result = await writeSpecialItemsWithCleanup(ctx, [committedItem, neverCommittedItem]);
    expect(result).toMatchObject({ name: 'BatchWriteAllIncompleteError' });
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['committed-old.bin']);
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['never-committed-new.bin']);
  });
});
