import { GetCommand } from '@aws-sdk/lib-dynamodb';

import { writeRegularItems } from '../../../../src/checkpointer/internal/regular-write';
import type { CheckpointWriteItem } from '../../../../src/checkpointer/internal/rows';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import {
  committedRows,
  createStrictDocumentMock,
  rejectRowWrites,
  resolveRowWrites,
} from '../../../shared/helpers/ddb-mock';

const serde = {
  dumpsTyped: (): Promise<[string, Uint8Array]> => Promise.resolve(['json', new Uint8Array()]),
  loadsTyped: (): Promise<unknown> => Promise.resolve({}),
};

function context(client: CheckpointerContext['client'], offloader = true): CheckpointerContext {
  const base: CheckpointerContext = { client, tableName: 'ckpt', serde, logger: SILENT_LOGGER };
  return offloader ? { ...base, offloader: {} as never } : base;
}

function item(writeGroup: string, s3Key = `k/${writeGroup}`): CheckpointWriteItem {
  return {
    PK: 'CHKPT#t',
    SK: 'WRITE##c1#task#0000000008#ch',
    taskId: 'task',
    index: 0,
    channel: 'ch',
    writeGroup,
    occurrence: 0,
    value: { location: PayloadLocation.S3, serdeType: 'json', compressed: false, s3Key },
  };
}

/**
 * The first-write-wins rejection as this path now reports it. Every item here
 * is offloaded, so every write goes out as a one-item transaction and its
 * refusal arrives as a cancellation carrying one `ConditionalCheckFailed`
 * reason rather than as the bare exception a plain put answers with.
 */
function ccf(rawItem?: Record<string, { S: string }>): Error {
  return Object.assign(new Error('conflict'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [
      { Code: 'ConditionalCheckFailed', ...(rawItem ? { Item: rawItem } : {}) },
    ],
  });
}

function timeout(): Error {
  return Object.assign(new Error('timeout'), { name: 'ETIMEDOUT' });
}

describe('writeRegularItems', () => {
  it('reports no dead uploads and no error when every put succeeds', async () => {
    const { client, mock } = createStrictDocumentMock();
    resolveRowWrites(mock);
    await expect(writeRegularItems(context(client), [item('G1')])).resolves.toEqual({
      deadUploads: [],
    });
    expect(committedRows(mock)).toEqual([item('G1')]);
  });

  it("treats a lost-response retry exhaustion as committed when the row holds this call's writeGroup", async () => {
    const { client, mock } = createStrictDocumentMock();
    rejectRowWrites(mock, timeout());
    mock.on(GetCommand).resolves({ Item: { writeGroup: 'G1', value: item('G1').value } });
    const outcome = await writeRegularItems(context(client), [item('G1')]);
    expect(outcome).toEqual({ deadUploads: [] });
    expect(mock.commandCalls(GetCommand)[0].args[0].input.ConsistentRead).toBe(true);
  });

  it('marks the upload dead and keeps the error when the row is absent after retry exhaustion', async () => {
    const { client, mock } = createStrictDocumentMock();
    rejectRowWrites(mock, timeout());
    mock.on(GetCommand).resolves({});
    const outcome = await writeRegularItems(context(client), [item('G1')]);
    expect(outcome.deadUploads).toEqual([item('G1')]);
    expect(outcome.error).toMatchObject({
      name: 'DynamoDBLangGraphError',
      code: ErrorCode.RETRY_EXHAUSTED,
    });
  });

  it("marks the upload dead when the row holds another call's writeGroup", async () => {
    const { client, mock } = createStrictDocumentMock();
    rejectRowWrites(mock, timeout());
    mock.on(GetCommand).resolves({ Item: { writeGroup: 'OTHER' } });
    const outcome = await writeRegularItems(context(client), [item('G1')]);
    expect(outcome.deadUploads).toEqual([item('G1')]);
  });

  it('keeps the error but leaks the upload when the verification read fails', async () => {
    const { client, mock } = createStrictDocumentMock();
    rejectRowWrites(mock, timeout());
    mock
      .on(GetCommand)
      .rejects(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    const outcome = await writeRegularItems(context(client), [item('G1')]);
    expect(outcome.deadUploads).toEqual([]);
    expect(outcome.error).toMatchObject({
      name: 'DynamoDBLangGraphError',
      code: ErrorCode.RETRY_EXHAUSTED,
    });
  });

  it('skips the verification read and marks the upload dead when no offloader is configured', async () => {
    const { client, mock } = createStrictDocumentMock();
    rejectRowWrites(mock, Object.assign(new Error('bad'), { name: 'ValidationException' }));
    const outcome = await writeRegularItems(context(client, false), [item('G1')]);
    expect(outcome.deadUploads).toHaveLength(1);
    expect(outcome.error).toMatchObject({ name: 'ValidationException' });
    expect(mock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('keeps the first error when several writes fail', async () => {
    const { client, mock } = createStrictDocumentMock();
    rejectRowWrites(mock, Object.assign(new Error('bad'), { name: 'ValidationException' }));
    const outcome = await writeRegularItems(context(client, false), [
      item('G1'),
      item('G1', 'k/2'),
    ]);
    expect(outcome.deadUploads).toHaveLength(2);
    expect(outcome.error).toMatchObject({ name: 'ValidationException' });
  });

  it('marks a guard-rejected write dead when the returned row belongs to another call (CKPT-09)', async () => {
    const { client, mock } = createStrictDocumentMock();
    rejectRowWrites(mock, ccf({ channel: { S: 'ch' }, writeGroup: { S: 'OTHER' } }));
    const outcome = await writeRegularItems(context(client), [item('G1')]);
    expect(outcome).toEqual({ deadUploads: [item('G1')] });
  });

  it('never marks a guard-rejected write dead when the returned row is its own (lost-response re-hit)', async () => {
    const { client, mock } = createStrictDocumentMock();
    rejectRowWrites(mock, ccf({ channel: { S: 'ch' }, writeGroup: { S: 'G1' } }));
    await expect(writeRegularItems(context(client), [item('G1')])).resolves.toEqual({
      deadUploads: [],
    });
  });

  it('never marks a guard-rejected write dead when the rejection carries no attributes', async () => {
    const { client, mock } = createStrictDocumentMock();
    rejectRowWrites(mock, ccf());
    await expect(writeRegularItems(context(client), [item('G1')])).resolves.toEqual({
      deadUploads: [],
    });
  });

  /**
   * The cancellation guarantee, at the site it protects. The caller's signal
   * reaches the put and ends it, and the verification read that follows the
   * failure is issued all the same — it runs on the adapter's own retry
   * options, which carry no signal, so a cancel can never leave a live row
   * pointing at an object the cleanup then released.
   */
  it('cancels the put but not the verification read that follows it', async () => {
    const { client, mock } = createStrictDocumentMock();
    const controller = new AbortController();
    controller.abort();
    rejectRowWrites(mock, timeout());
    mock.on(GetCommand).resolves({ Item: { writeGroup: 'OTHER' } });
    const outcome = await writeRegularItems(context(client), [item('G1')], controller.signal);
    expect(outcome.error).toMatchObject({ name: 'DynamoDBLangGraphError', code: 'ABORTED' });
    expect(mock.commandCalls(GetCommand)).toHaveLength(1);
    expect(outcome.deadUploads).toEqual([item('G1')]);
  });
});
