import { BatchWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { deleteThread } from '../../../../src/checkpointer/actions/delete-thread';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { MAX_LOOP_ITERATIONS } from '../../../../src/shared/constants';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const serde = {
  dumpsTyped: async (): Promise<[string, Uint8Array]> => ['json', new Uint8Array()],
  loadsTyped: async (): Promise<unknown> => ({}),
};

function context(client: CheckpointerContext['client']): CheckpointerContext {
  return { client, tableName: 'ckpt', serde, logger: SILENT_LOGGER };
}

describe('deleteThread', () => {
  it('deletes every item in the thread partition', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({
      Items: [
        { PK: 't', SK: 'META##c1' },
        { PK: 't', SK: 'PAYLOAD##c1' },
        { PK: 't', SK: 'WRITE##c1#task#0' },
      ],
    });
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    await deleteThread(context(client), 't');
    const requests = mock.commandCalls(BatchWriteCommand)[0].args[0].input.RequestItems?.ckpt ?? [];
    expect(requests).toHaveLength(3);
    expect(requests.map((r) => r.DeleteRequest?.Key?.SK)).toEqual([
      'META##c1',
      'PAYLOAD##c1',
      'WRITE##c1#task#0',
    ]);
  });

  it('deletes a partition that spans more pages than the default iteration cap', async () => {
    const { client, mock } = createStrictDocumentMock();
    const total = MAX_LOOP_ITERATIONS + 5;
    let page = 0;
    mock.on(QueryCommand).callsFake(() => {
      page += 1;
      const hasMore = page < total;
      return {
        Items: [{ PK: 't', SK: `WRITE##c#task#${page}` }],
        LastEvaluatedKey: hasMore ? { PK: 't', SK: `${page}` } : undefined,
      };
    });
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    await deleteThread(context(client), 't');
    const deleted = mock
      .commandCalls(BatchWriteCommand)
      .flatMap((call) =>
        (call.args[0].input.RequestItems?.ckpt ?? []).map((r) => r.DeleteRequest?.Key?.SK),
      );
    expect(deleted).toHaveLength(total);
    expect(new Set(deleted).size).toBe(total);
  });

  it('is a no-op when the thread has no items', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    await deleteThread(context(client), 't');
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('best-effort deletes offloaded S3 objects referenced by the items', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({
      Items: [
        {
          PK: 't',
          SK: 'PAYLOAD##c1',
          checkpoint: { location: PayloadLocation.S3, serdeType: 'json', s3Key: 'k-cp' },
        },
      ],
    });
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    const offloader = { deleteBatch: jest.fn().mockResolvedValue([]) };
    await deleteThread({ ...context(client), offloader: offloader as never }, 't');
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['k-cp']);
  });

  it('reads the partition strongly-consistently before deleting', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    await deleteThread(context(client), 't');
    expect(mock.commandCalls(QueryCommand)[0].args[0].input.ConsistentRead).toBe(true);
  });

  it('rejects an empty thread id', async () => {
    const { client } = createStrictDocumentMock();
    try {
      await deleteThread(context(client), '');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { code: ErrorCode }).code).toBe(ErrorCode.VALIDATION);
    }
  });

  it('rejects a thread id carrying the reserved separator, like every other action (M5)', async () => {
    const { client } = createStrictDocumentMock();
    await expect(deleteThread(context(client), 'a#b')).rejects.toThrow(/reserved "#" separator/);
  });

  it('leaves a row that is not a checkpointer row in place, and warns (C1, I7)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({
      Items: [
        { PK: 'CHKPT#t', SK: 'META##c1' },
        { PK: 'CHKPT#t', SK: 'HISTORY#SESSION' },
        { PK: 'CHKPT#t', SK: 'some-store-key' },
      ],
    });
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    const warn = jest.fn();
    await deleteThread({ ...context(client), logger: { ...SILENT_LOGGER, warn } }, 't');
    const requests = mock.commandCalls(BatchWriteCommand)[0].args[0].input.RequestItems?.ckpt ?? [];
    expect(requests.map((r) => r.DeleteRequest?.Key?.SK)).toEqual(['META##c1']);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('reports cumulative deletes when a later flush fails (M5)', async () => {
    const { client, mock } = createStrictDocumentMock();
    // 30 rows: the first flush of 25 succeeds, the flush of the remaining 5 fails.
    mock.on(QueryCommand).resolves({
      Items: Array.from({ length: 30 }, (_, i) => ({ PK: 'CHKPT#t', SK: `META##c${i}` })),
    });
    let call = 0;
    mock.on(BatchWriteCommand).callsFake(() => {
      call += 1;
      if (call === 1) return { UnprocessedItems: {} };
      throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
    });
    await expect(deleteThread(context(client), 't')).rejects.toMatchObject({
      code: ErrorCode.BATCH_WRITE_INCOMPLETE,
      succeededCount: 25,
    });
  });

  it('logs how many rows it deleted (I7)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [{ PK: 'CHKPT#t', SK: 'META##c1' }] });
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    const info = jest.fn();
    await deleteThread({ ...context(client), logger: { ...SILENT_LOGGER, info } }, 't');
    expect(info).toHaveBeenCalledWith(expect.stringContaining('deleted'), {
      deleted: 1,
      skipped: 0,
    });
  });
});
