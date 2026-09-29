import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

import {
  writeRegularRows,
  writeSpecialRow,
} from '../../../../src/checkpointer/internal/pending-writes';
import type { CheckpointWriteRow } from '../../../../src/checkpointer/internal/rows';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const serde = {
  dumpsTyped: (): Promise<[string, Uint8Array]> => Promise.resolve(['json', new Uint8Array()]),
  loadsTyped: (): Promise<unknown> => Promise.resolve({}),
};

function context(client: CheckpointerContext['client']): CheckpointerContext {
  return { client, tableName: 'ckpt', serde, logger: SILENT_LOGGER, offloader: {} as never };
}

function item(writeGroup: string, channel = 'ch'): CheckpointWriteRow {
  return {
    PK: 'CHKPT#t',
    SK: `WRITE##c1#task#0000000008#${channel}`,
    taskId: 'task',
    index: 0,
    channel,
    writeGroup,
    occurrence: 0,
    value: {
      location: PayloadLocation.S3,
      serdeType: 'json',
      compressed: false,
      s3Key: `k/${writeGroup}`,
    },
  };
}

const cutShort = (controller: AbortController) => () => {
  controller.abort();
  return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
};

/** A first-write-wins or compare-and-swap refusal carrying the row that won. */
function refusedBy(writeGroup: string): Error {
  return Object.assign(new Error('conflict'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [
      { Code: 'ConditionalCheckFailed', Item: { writeGroup: { S: writeGroup } } },
    ],
  });
}

describe('writeRegularRows under a cancel', () => {
  it('keeps the upload of a write the cancel cut short while its row is still absent', async () => {
    const { client, mock } = createStrictDocumentMock();
    const controller = new AbortController();
    mock.on(TransactWriteCommand).callsFake(cutShort(controller));
    mock.on(GetCommand).resolves({});
    const outcome = await writeRegularRows(context(client), [item('G1')], controller.signal);
    expect(outcome.error).toMatchObject({ code: ErrorCode.ABORTED });
    expect(outcome.deadUploads).toEqual([]);
  });

  it('releases the upload once another call holds the row, which first-write-wins keeps', async () => {
    const { client, mock } = createStrictDocumentMock();
    const controller = new AbortController();
    mock.on(TransactWriteCommand).callsFake(cutShort(controller));
    mock.on(GetCommand).resolves({ Item: { writeGroup: 'OTHER' } });
    const outcome = await writeRegularRows(context(client), [item('G1')], controller.signal);
    expect(outcome.deadUploads).toEqual([item('G1')]);
  });

  it('sends nothing, and releases every upload, when the cancel came before the writes', async () => {
    const { client, mock } = createStrictDocumentMock();
    const controller = new AbortController();
    controller.abort();
    const outcome = await writeRegularRows(
      context(client),
      [item('G1'), item('G2')],
      controller.signal,
    );
    expect(outcome.error).toMatchObject({ code: ErrorCode.ABORTED });
    expect(outcome.deadUploads).toEqual([item('G1'), item('G2')]);
    expect(mock.calls()).toHaveLength(0);
  });
});

describe('writeSpecialRow under a cancel', () => {
  it('keeps its upload when the cancel cut its write short and the row is unchanged', async () => {
    const { client, mock } = createStrictDocumentMock();
    const controller = new AbortController();
    mock.on(GetCommand).resolves({});
    mock.on(TransactWriteCommand).callsFake(cutShort(controller));
    const outcome = await writeSpecialRow(
      context(client),
      item('G1', '__interrupt__'),
      controller.signal,
    );
    expect(outcome).toMatchObject({
      committed: true,
      error: expect.objectContaining({ code: ErrorCode.ABORTED }),
    });
  });

  it('releases its upload without writing when the cancel came before the write', async () => {
    const { client, mock } = createStrictDocumentMock();
    const controller = new AbortController();
    mock.on(GetCommand).callsFake(() => {
      controller.abort();
      return Promise.resolve({});
    });
    const outcome = await writeSpecialRow(
      context(client),
      item('G1', '__interrupt__'),
      controller.signal,
    );
    expect(outcome).toMatchObject({
      committed: false,
      error: expect.objectContaining({ code: ErrorCode.ABORTED }),
    });
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('skips the unconditional overwrite when the cancel came after the compare-and-swap ran out', async () => {
    const { client, mock } = createStrictDocumentMock();
    const controller = new AbortController();
    mock.on(GetCommand).resolves({});
    let refusals = 0;
    mock.on(TransactWriteCommand).callsFake(() => {
      refusals += 1;
      return Promise.reject(refusedBy(`OTHER-${refusals}`));
    });
    const warn = jest.fn(() => controller.abort());
    const outcome = await writeSpecialRow(
      { ...context(client), logger: { ...SILENT_LOGGER, warn } },
      item('G1', '__interrupt__'),
      controller.signal,
    );
    expect(outcome).toMatchObject({
      committed: false,
      error: expect.objectContaining({ code: ErrorCode.ABORTED }),
    });
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(3);
  });
});
