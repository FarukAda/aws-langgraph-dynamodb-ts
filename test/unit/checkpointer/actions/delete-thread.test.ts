import { DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { deleteThread } from '../../../../src/checkpointer/actions/delete-thread';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { buildS3Key, isKeyInScope } from '../../../../src/shared/codec/s3/config';
import { MAX_LOOP_ITERATIONS } from '../../../../src/shared/dynamodb/paginate';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { conditionalTable } from '../../../shared/helpers/conditional-delete';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const serde = {
  dumpsTyped: (): Promise<[string, Uint8Array]> => Promise.resolve(['json', new Uint8Array()]),
  loadsTyped: (): Promise<unknown> => Promise.resolve({}),
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
    mock.on(DeleteCommand).resolves({});
    await deleteThread(context(client), 't');
    const deleted = mock.commandCalls(DeleteCommand).map((call) => call.args[0].input.Key?.SK);
    expect(deleted).toEqual(['META##c1', 'PAYLOAD##c1', 'WRITE##c1#task#0']);
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
    mock.on(DeleteCommand).resolves({});
    await deleteThread(context(client), 't');
    const deleted = mock.commandCalls(DeleteCommand).map((call) => call.args[0].input.Key?.SK);
    expect(deleted).toHaveLength(total);
    expect(new Set(deleted).size).toBe(total);
  });

  it('is a no-op when the thread has no items', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    await deleteThread(context(client), 't');
    expect(mock.commandCalls(DeleteCommand)).toHaveLength(0);
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
    mock.on(DeleteCommand).resolves({});
    const offloader = { deleteBatch: jest.fn().mockResolvedValue([]), ownsKey: () => true };
    await deleteThread({ ...context(client), offloader: offloader as never }, 't');
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['k-cp']);
  });

  /**
   * A WRITE row a repair tool or a foreign writer left with a `null` payload
   * attribute still carries its own `writeGroup`, so the pin comes off the row
   * and the descriptor is first read by the S3 cleanup the flush runs on its
   * way out — the one that documents it throws nothing. Reading `location` off
   * the `null` ended the whole thread delete with a bare TypeError instead, and
   * the rows of every other kind in the partition stayed.
   */
  it('deletes a row whose payload attribute is null and releases nothing for it', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({
      Items: [
        { PK: 't', SK: 'WRITE##c1#task#0', writeGroup: 'g1', value: null },
        {
          PK: 't',
          SK: 'PAYLOAD##c1',
          checkpoint: { location: PayloadLocation.S3, serdeType: 'json', s3Key: 'k-cp' },
        },
      ],
    });
    mock.on(DeleteCommand).resolves({});
    const offloader = { deleteBatch: jest.fn().mockResolvedValue([]), ownsKey: () => true };
    await deleteThread({ ...context(client), offloader: offloader as never }, 't');
    const deleted = mock.commandCalls(DeleteCommand).map((call) => call.args[0].input.Key?.SK);
    expect(deleted).toEqual(['WRITE##c1#task#0', 'PAYLOAD##c1']);
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['k-cp']);
  });

  /**
   * A META or PAYLOAD row carries no `writeGroup`, so its pin is looked for on
   * the descriptors instead. A `null` payload attribute is no descriptor at
   * all: it must count as the absent id it is and leave the row deleted
   * unconditionally, not end the pass by being read for a write id.
   */
  it('deletes a row with no write id whose payload attribute is null', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({
      Items: [
        { PK: 't', SK: 'META##c1', metadata: null },
        { PK: 't', SK: 'WRITE##c1#task#0', writeGroup: 'g1' },
      ],
    });
    mock.on(DeleteCommand).resolves({});
    await deleteThread(context(client), 't');
    const calls = mock.commandCalls(DeleteCommand).map((call) => call.args[0].input);
    expect(calls.map((input) => input.Key?.SK)).toEqual(['META##c1', 'WRITE##c1#task#0']);
    expect(calls[0].ConditionExpression).toBeUndefined();
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

  it('rejects a thread id carrying the reserved separator, like every other action', async () => {
    const { client } = createStrictDocumentMock();
    await expect(deleteThread(context(client), 'a#b')).rejects.toThrow(/reserved "#" separator/);
  });

  it('leaves a row that is not a checkpointer row in place, and warns', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({
      Items: [
        { PK: 'CHKPT#t', SK: 'META##c1' },
        { PK: 'CHKPT#t', SK: 'HISTORY#SESSION' },
        { PK: 'CHKPT#t', SK: 'some-store-key' },
      ],
    });
    mock.on(DeleteCommand).resolves({});
    const warn = jest.fn();
    await deleteThread({ ...context(client), logger: { ...SILENT_LOGGER, warn } }, 't');
    const deleted = mock.commandCalls(DeleteCommand).map((call) => call.args[0].input.Key?.SK);
    expect(deleted).toEqual(['META##c1']);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('reports cumulative deletes when a later flush fails', async () => {
    const { client, mock } = createStrictDocumentMock();
    // 30 rows: the first flush of 25 rows succeeds, the flush of the remaining 5 fails.
    mock.on(QueryCommand).resolves({
      Items: Array.from({ length: 30 }, (_, i) => ({ PK: 'CHKPT#t', SK: `META##c${i}` })),
    });
    let call = 0;
    mock.on(DeleteCommand).callsFake(() => {
      call += 1;
      if (call <= 25) return {};
      throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    });
    await expect(deleteThread(context(client), 't')).rejects.toMatchObject({
      code: ErrorCode.BATCH_WRITE_INCOMPLETE,
      details: { succeededCount: 25 },
    });
  });

  /**
   * The pin, end to end through this action's own keys and attributes: the
   * checkpoint was re-put after the read, so its META row is refused, and the
   * unit that refusal names suppresses the PAYLOAD and WRITE rows behind it.
   * Deleting them would have left a surviving checkpoint without the pending
   * writes its caller was told had persisted.
   */
  it('leaves a checkpoint re-put during the pass alone, and its pending writes with it', async () => {
    const { client, mock } = createStrictDocumentMock();
    const descriptor = (writeId: string) => ({
      location: PayloadLocation.S3,
      serdeType: 'json',
      compressed: false,
      s3Key: `k-${writeId}`,
      writeId,
    });
    const observed = [
      { PK: 'CHKPT#t', SK: 'META##c1', metadata: descriptor('w1') },
      { PK: 'CHKPT#t', SK: 'PAYLOAD##c1', checkpoint: descriptor('w1') },
      {
        PK: 'CHKPT#t',
        SK: 'WRITE##c1#task#0000000008#ch',
        writeGroup: 'g1',
        value: descriptor('g1'),
      },
    ];
    const table = conditionalTable([
      { ...observed[0], metadata: descriptor('w2') },
      { ...observed[1], checkpoint: descriptor('w2') },
      observed[2],
    ]);
    mock.on(QueryCommand).resolves({ Items: observed });
    mock.on(DeleteCommand).callsFake(table.handler);
    const offloader = { deleteBatch: jest.fn().mockResolvedValue([]), ownsKey: () => true };
    await deleteThread({ ...context(client), offloader: offloader as never }, 't');
    expect(table.rows.size).toBe(3);
    expect(table.issued).toEqual(['META##c1']);
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
  });

  it('logs how many rows it deleted', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [{ PK: 'CHKPT#t', SK: 'META##c1' }] });
    mock.on(DeleteCommand).resolves({});
    const info = jest.fn();
    await deleteThread({ ...context(client), logger: { ...SILENT_LOGGER, info } }, 't');
    expect(info).toHaveBeenCalledWith(expect.stringContaining('deleted'), {
      deleted: 1,
      skipped: 0,
    });
  });
});

describe('deleteThread S3 key binding', () => {
  it("never deletes an offloaded object outside the thread's own path, and warns", async () => {
    const { client, mock } = createStrictDocumentMock();
    const own = buildS3Key('p/', ['t', '', 'c1', 'checkpoint'], '01J9ZQ5X3N8VQ4M6C2T7R0K1HD');
    const foreign = buildS3Key(
      'p/',
      ['victim', '', 'c9', 'checkpoint'],
      '01J9ZQ5X3N8VQ4M6C2T7R0K1HD',
    );
    const s3 = (s3Key: string) => ({
      location: PayloadLocation.S3,
      serdeType: 'json',
      compressed: false,
      s3Key,
    });
    mock.on(QueryCommand).resolves({
      Items: [
        { PK: 'CHKPT#t', SK: 'PAYLOAD##c1', checkpoint: s3(own) },
        { PK: 'CHKPT#t', SK: 'PAYLOAD##c2', checkpoint: s3(foreign) },
      ],
    });
    mock.on(DeleteCommand).resolves({});
    const offloader = {
      deleteBatch: jest.fn().mockResolvedValue([]),
      ownsKey: (key: string, scope: readonly string[]) => isKeyInScope(key, 'p/', scope),
    };
    const warn = jest.fn();
    await deleteThread(
      { ...context(client), offloader: offloader as never, logger: { ...SILENT_LOGGER, warn } },
      't',
    );
    expect(offloader.deleteBatch).toHaveBeenCalledWith([own]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('outside'),
      expect.objectContaining({ key: foreign }),
    );
  });
});

/**
 * The signal has to reach the row deletes, not only the page reads. A pass that
 * hands it to `paginateQuery` alone still empties a single-page partition after
 * the caller stopped it, and reports the cancel — so "it threw `ABORTED`" is
 * satisfied by exactly the version the cancel exists to prevent. The request
 * count is what separates them: the three rows are three kinds, each flushed on
 * its own, so only the first is ever issued.
 */
describe('a cancelled deleteThread', () => {
  it('issues no further row delete once the signal has fired part-way through the pass', async () => {
    const { client, mock } = createStrictDocumentMock();
    const controller = new AbortController();
    mock.on(QueryCommand).resolves({
      Items: [
        { PK: 't', SK: 'META##c1' },
        { PK: 't', SK: 'PAYLOAD##c1' },
        { PK: 't', SK: 'WRITE##c1#task#0' },
      ],
    });
    mock.on(DeleteCommand).callsFake(() => {
      controller.abort();
      return {};
    });
    await expect(
      deleteThread(context(client), 't', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'DynamoDBLangGraphError', code: ErrorCode.ABORTED });
    expect(mock.commandCalls(DeleteCommand)).toHaveLength(1);
  });
});
