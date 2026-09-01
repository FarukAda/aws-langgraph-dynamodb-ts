import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

import { writeRegularItems } from '../../../../src/checkpointer/internal/regular-write';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import type { CheckpointWriteItem } from '../../../../src/checkpointer/types';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const serde = {
  dumpsTyped: async (): Promise<[string, Uint8Array]> => ['json', new Uint8Array()],
  loadsTyped: async (): Promise<unknown> => ({}),
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

function ccf(rawItem?: Record<string, { S: string }>): Error {
  return Object.assign(new Error('conflict'), {
    name: 'ConditionalCheckFailedException',
    Item: rawItem,
  });
}

function timeout(): Error {
  return Object.assign(new Error('timeout'), { name: 'ETIMEDOUT' });
}

describe('writeRegularItems', () => {
  it('reports no dead uploads and no error when every put succeeds', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(PutCommand).resolves({});
    await expect(writeRegularItems(context(client), [item('G1')])).resolves.toEqual({
      deadUploads: [],
    });
    const input = mock.commandCalls(PutCommand)[0].args[0].input;
    expect(input.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(input.ReturnValuesOnConditionCheckFailure).toBe('ALL_OLD');
  });

  it("treats a lost-response retry exhaustion as committed when the row holds this call's writeGroup", async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(PutCommand).rejects(timeout());
    mock.on(GetCommand).resolves({ Item: { writeGroup: 'G1', value: item('G1').value } });
    const outcome = await writeRegularItems(context(client), [item('G1')]);
    expect(outcome).toEqual({ deadUploads: [] });
    expect(mock.commandCalls(GetCommand)[0].args[0].input.ConsistentRead).toBe(true);
  });

  it('marks the upload dead and keeps the error when the row is absent after retry exhaustion', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(PutCommand).rejects(timeout());
    mock.on(GetCommand).resolves({});
    const outcome = await writeRegularItems(context(client), [item('G1')]);
    expect(outcome.deadUploads).toHaveLength(1);
    expect(outcome.error).toMatchObject({ name: 'RetryExhaustedError' });
  });

  it("marks the upload dead when the row holds another call's writeGroup", async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(PutCommand).rejects(timeout());
    mock.on(GetCommand).resolves({ Item: { writeGroup: 'OTHER' } });
    const outcome = await writeRegularItems(context(client), [item('G1')]);
    expect(outcome.deadUploads).toHaveLength(1);
  });

  it('keeps the error but leaks the upload when the verification read fails', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(PutCommand).rejects(timeout());
    mock
      .on(GetCommand)
      .rejects(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    const outcome = await writeRegularItems(context(client), [item('G1')]);
    expect(outcome.deadUploads).toEqual([]);
    expect(outcome.error).toMatchObject({ name: 'RetryExhaustedError' });
  });

  it('skips the verification read and marks the upload dead when no offloader is configured', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(PutCommand).rejects(Object.assign(new Error('bad'), { name: 'ValidationException' }));
    const outcome = await writeRegularItems(context(client, false), [item('G1')]);
    expect(outcome.deadUploads).toHaveLength(1);
    expect(outcome.error).toMatchObject({ name: 'ValidationException' });
    expect(mock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('keeps the first error when several writes fail', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(PutCommand).rejects(Object.assign(new Error('bad'), { name: 'ValidationException' }));
    const outcome = await writeRegularItems(context(client, false), [
      item('G1'),
      item('G1', 'k/2'),
    ]);
    expect(outcome.deadUploads).toHaveLength(2);
    expect(outcome.error).toMatchObject({ name: 'ValidationException' });
  });

  it('marks a guard-rejected write dead when the returned row belongs to another call (CKPT-09)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(PutCommand).rejects(ccf({ channel: { S: 'ch' }, writeGroup: { S: 'OTHER' } }));
    const outcome = await writeRegularItems(context(client), [item('G1')]);
    expect(outcome).toEqual({ deadUploads: [item('G1')] });
  });

  it('never marks a guard-rejected write dead when the returned row is its own (lost-response re-hit)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(PutCommand).rejects(ccf({ channel: { S: 'ch' }, writeGroup: { S: 'G1' } }));
    await expect(writeRegularItems(context(client), [item('G1')])).resolves.toEqual({
      deadUploads: [],
    });
  });

  it('never marks a guard-rejected write dead when the rejection carries no attributes', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(PutCommand).rejects(ccf());
    await expect(writeRegularItems(context(client), [item('G1')])).resolves.toEqual({
      deadUploads: [],
    });
  });
});
