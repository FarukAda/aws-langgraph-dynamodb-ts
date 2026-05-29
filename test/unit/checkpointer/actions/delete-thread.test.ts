/**
 * Strict unit tests for deleteThreadAction (src/checkpointer/actions/delete-thread.ts).
 *
 * Characterizes the existing, assumed-correct source:
 *  - paginated Query over the checkpoints table (exact QueryCommand input,
 *    including empty-page-with-LastEvaluatedKey continuation), then
 *  - BatchWriteCommand DeleteRequests for ALL checkpoint items (metadata +
 *    PAYLOAD#), then a per-metadata-checkpoint writes Query, then a
 *    BatchWriteCommand DeleteRequests for the writes,
 *  - the early-return when the thread has no items (single Query, no writes),
 *  - error paths: throttling (retried), non-retryable AWS errors
 *    (ResourceNotFound / ConditionalCheckFailed) surfaced immediately, and
 *    AbortError short-circuit on a pre-aborted signal (zero DDB calls).
 */
import { BatchWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { deleteThreadAction } from '../../../../src/checkpointer/actions/delete-thread';
import type { DeleteThreadActionParams } from '../../../../src/checkpointer/types';
import { THREAD_ID } from '../../../shared/fixtures/test-data';
import { preAbortedSignal } from '../../../shared/helpers/abort';
import {
  expectExactQueryCommand,
  expectNoUnexpectedCommands,
} from '../../../shared/helpers/strict-ddb-assertions';
import { createStrictDdbMock, type StrictDdbMock } from '../../../shared/mocks/dynamodb';

const CHECKPOINTS_TABLE = 'checkpoints-table';
const WRITES_TABLE = 'writes-table';
const SEPARATOR = ':::';

function makeParams(overrides: Partial<DeleteThreadActionParams> = {}): DeleteThreadActionParams {
  return {
    client: (overrides as { client?: unknown }).client as DeleteThreadActionParams['client'],
    checkpointsTableName: CHECKPOINTS_TABLE,
    writesTableName: WRITES_TABLE,
    threadId: THREAD_ID,
    ...overrides,
  };
}

/** A metadata checkpoint item as returned by the checkpoints Query. */
function metadataItem(checkpointId: string): Record<string, unknown> {
  return {
    thread_id: THREAD_ID,
    checkpoint_id: checkpointId,
    checkpoint_ns: '',
    type: 'json',
  };
}

/** A PAYLOAD# item as returned by the checkpoints Query. */
function payloadItem(checkpointId: string): Record<string, unknown> {
  return {
    thread_id: THREAD_ID,
    checkpoint_id: `PAYLOAD#${checkpointId}`,
  };
}

describe('deleteThreadAction', () => {
  let ddb: StrictDdbMock;

  beforeEach(() => {
    ddb = createStrictDdbMock();
  });

  afterEach(() => {
    ddb.mock.restore();
  });

  it('returns without any batch-write when the thread Query yields no items (single QueryCommand)', async () => {
    ddb.mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });

    await deleteThreadAction(
      makeParams({ client: ddb.mock as unknown as DeleteThreadActionParams['client'] }),
    );

    expectExactQueryCommand(ddb.mock, {
      TableName: CHECKPOINTS_TABLE,
      KeyConditionExpression: 'thread_id = :thread_id',
      ExpressionAttributeValues: { ':thread_id': THREAD_ID },
      ExclusiveStartKey: undefined,
    });
    expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
  }); // AC-8

  it('paginates the checkpoints Query across an empty page carrying a LastEvaluatedKey, then deletes all items and their writes', async () => {
    const continuation = { thread_id: THREAD_ID, checkpoint_id: 'cursor-1' };

    // Page 1: an EMPTY page that still carries a LastEvaluatedKey — the loop
    // MUST continue paginating rather than stop on the empty page.
    ddb.mock
      .on(QueryCommand, {
        TableName: CHECKPOINTS_TABLE,
        KeyConditionExpression: 'thread_id = :thread_id',
        ExpressionAttributeValues: { ':thread_id': THREAD_ID },
        ExclusiveStartKey: undefined,
      })
      .resolves({ Items: [], LastEvaluatedKey: continuation });

    // Page 2: real items (one metadata + its payload), no further pages.
    ddb.mock
      .on(QueryCommand, {
        TableName: CHECKPOINTS_TABLE,
        KeyConditionExpression: 'thread_id = :thread_id',
        ExpressionAttributeValues: { ':thread_id': THREAD_ID },
        ExclusiveStartKey: continuation,
      })
      .resolves({
        Items: [metadataItem('ckpt-1'), payloadItem('ckpt-1')],
        LastEvaluatedKey: undefined,
      });

    // Writes Query for the single metadata checkpoint: one write item.
    const writePk = [THREAD_ID, 'ckpt-1', ''].join(SEPARATOR);
    ddb.mock
      .on(QueryCommand, {
        TableName: WRITES_TABLE,
        KeyConditionExpression: 'thread_id_checkpoint_id_checkpoint_ns = :pk',
        ExpressionAttributeValues: { ':pk': writePk },
        ExclusiveStartKey: undefined,
      })
      .resolves({
        Items: [{ thread_id_checkpoint_id_checkpoint_ns: writePk, task_id_idx: 'task-1:::0' }],
        LastEvaluatedKey: undefined,
      });

    ddb.mock.on(BatchWriteCommand).resolves({});

    await deleteThreadAction(
      makeParams({ client: ddb.mock as unknown as DeleteThreadActionParams['client'] }),
    );

    // Three QueryCommands fired: 2 checkpoint pages + 1 writes query.
    expect(ddb.mock.commandCalls(QueryCommand)).toHaveLength(3);

    // First BatchWrite deletes BOTH checkpoint items (metadata + payload) by PK+SK.
    const batchCalls = ddb.mock.commandCalls(BatchWriteCommand);
    expect(batchCalls).toHaveLength(2);
    expect(batchCalls[0].args[0].input).toEqual({
      RequestItems: {
        [CHECKPOINTS_TABLE]: [
          { DeleteRequest: { Key: { thread_id: THREAD_ID, checkpoint_id: 'ckpt-1' } } },
          { DeleteRequest: { Key: { thread_id: THREAD_ID, checkpoint_id: 'PAYLOAD#ckpt-1' } } },
        ],
      },
    });

    // Second BatchWrite deletes the writes by their composite keys.
    expect(batchCalls[1].args[0].input).toEqual({
      RequestItems: {
        [WRITES_TABLE]: [
          {
            DeleteRequest: {
              Key: {
                thread_id_checkpoint_id_checkpoint_ns: writePk,
                task_id_idx: 'task-1:::0',
              },
            },
          },
        ],
      },
    });

    expectNoUnexpectedCommands(ddb.mock, [QueryCommand, BatchWriteCommand]);
  }); // AC-8

  it('retries a throttled checkpoints Query and then completes the delete', async () => {
    jest.useRealTimers();
    const throttle = Object.assign(new Error('Rate exceeded'), {
      name: 'ThrottlingException',
    });

    ddb.mock
      .on(QueryCommand, {
        TableName: CHECKPOINTS_TABLE,
        KeyConditionExpression: 'thread_id = :thread_id',
        ExpressionAttributeValues: { ':thread_id': THREAD_ID },
        ExclusiveStartKey: undefined,
      })
      .rejectsOnce(throttle)
      .resolves({ Items: [], LastEvaluatedKey: undefined });

    await deleteThreadAction(
      makeParams({ client: ddb.mock as unknown as DeleteThreadActionParams['client'] }),
    );

    // Two attempts of the SAME query input (throttled once, then succeeded).
    const calls = ddb.mock.commandCalls(QueryCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0].args[0].input).toEqual(calls[1].args[0].input);
    expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
  }); // AC-19

  it('surfaces a non-retryable ResourceNotFoundException from the Query without retrying', async () => {
    const notFound = Object.assign(new Error('Requested resource not found'), {
      name: 'ResourceNotFoundException',
    });
    ddb.mock.on(QueryCommand).rejects(notFound);

    await expect(
      deleteThreadAction(
        makeParams({ client: ddb.mock as unknown as DeleteThreadActionParams['client'] }),
      ),
    ).rejects.toBe(notFound);

    // Non-retryable: exactly one attempt, no batch writes.
    expect(ddb.mock.commandCalls(QueryCommand)).toHaveLength(1);
    expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
  }); // AC-8

  it('surfaces a non-retryable ConditionalCheckFailedException from the delete BatchWrite without retrying', async () => {
    ddb.mock
      .on(QueryCommand, {
        TableName: CHECKPOINTS_TABLE,
        KeyConditionExpression: 'thread_id = :thread_id',
        ExpressionAttributeValues: { ':thread_id': THREAD_ID },
        ExclusiveStartKey: undefined,
      })
      .resolves({ Items: [metadataItem('ckpt-1')], LastEvaluatedKey: undefined });

    const condFail = Object.assign(new Error('The conditional request failed'), {
      name: 'ConditionalCheckFailedException',
    });
    ddb.mock.on(BatchWriteCommand).rejects(condFail);

    await expect(
      deleteThreadAction(
        makeParams({ client: ddb.mock as unknown as DeleteThreadActionParams['client'] }),
      ),
    ).rejects.toBe(condFail);

    // The checkpoints delete is attempted exactly once (non-retryable),
    // and the writes query never runs because the delete failed first.
    expect(ddb.mock.commandCalls(BatchWriteCommand)).toHaveLength(1);
    expectNoUnexpectedCommands(ddb.mock, [QueryCommand, BatchWriteCommand]);
  }); // AC-8

  it('rejects with the abort reason and issues zero DDB calls on a pre-aborted signal', async () => {
    const reason = new Error('cancelled-by-caller');
    ddb.mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });

    await expect(
      deleteThreadAction(
        makeParams({
          client: ddb.mock as unknown as DeleteThreadActionParams['client'],
          signal: preAbortedSignal(reason),
        }),
      ),
    ).rejects.toBe(reason);

    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-18

  it('rejects an empty thread id via validateThreadId and issues no DDB command', async () => {
    await expect(
      deleteThreadAction(
        makeParams({
          client: ddb.mock as unknown as DeleteThreadActionParams['client'],
          threadId: '',
        }),
      ),
    ).rejects.toThrow('thread_id cannot be empty');

    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-17

  it('collects S3 keys from metadata items AND write items, then deletes them in a single deleteBatch', async () => {
    // Guards lines 100-105 (metadata s3_checkpoint_key + s3_metadata_key),
    // 160-162 (write s3_value_key), and 177 (final deleteBatch). All three S3
    // sources must be aggregated and passed to the offloader's deleteBatch.
    const meta = {
      ...metadataItem('ckpt-1'),
      s3_checkpoint_key: 's3://bucket/ckpt-1-checkpoint',
      s3_metadata_key: 's3://bucket/ckpt-1-metadata',
    };
    ddb.mock
      .on(QueryCommand, {
        TableName: CHECKPOINTS_TABLE,
        KeyConditionExpression: 'thread_id = :thread_id',
        ExpressionAttributeValues: { ':thread_id': THREAD_ID },
        ExclusiveStartKey: undefined,
      })
      .resolves({ Items: [meta, payloadItem('ckpt-1')], LastEvaluatedKey: undefined });

    const writePk = [THREAD_ID, 'ckpt-1', ''].join(SEPARATOR);
    ddb.mock
      .on(QueryCommand, {
        TableName: WRITES_TABLE,
        KeyConditionExpression: 'thread_id_checkpoint_id_checkpoint_ns = :pk',
        ExpressionAttributeValues: { ':pk': writePk },
        ExclusiveStartKey: undefined,
      })
      .resolves({
        Items: [
          {
            thread_id_checkpoint_id_checkpoint_ns: writePk,
            task_id_idx: 'task-1:::0',
            s3_value_key: 's3://bucket/write-0-value',
          },
        ],
        LastEvaluatedKey: undefined,
      });

    ddb.mock.on(BatchWriteCommand).resolves({});
    const deleteBatch = jest.fn(async () => undefined);
    const s3Offloader = {
      deleteBatch,
    } as unknown as NonNullable<DeleteThreadActionParams['s3Offloader']>;

    await deleteThreadAction(
      makeParams({
        client: ddb.mock as unknown as DeleteThreadActionParams['client'],
        s3Offloader,
      }),
    );

    expect(deleteBatch).toHaveBeenCalledTimes(1);
    // Order: metadata checkpoint key, metadata metadata key, then write value key.
    expect(deleteBatch).toHaveBeenCalledWith([
      's3://bucket/ckpt-1-checkpoint',
      's3://bucket/ckpt-1-metadata',
      's3://bucket/write-0-value',
    ]);
  });

  it('does not call deleteBatch when an offloader is configured but no S3 keys are present', async () => {
    // Guards the false arm of the `s3KeysToDelete.length > 0` branch (line 176):
    // an offloader with zero collected keys must NOT issue a deleteBatch.
    ddb.mock
      .on(QueryCommand, {
        TableName: CHECKPOINTS_TABLE,
        KeyConditionExpression: 'thread_id = :thread_id',
        ExpressionAttributeValues: { ':thread_id': THREAD_ID },
        ExclusiveStartKey: undefined,
      })
      .resolves({ Items: [metadataItem('ckpt-1')], LastEvaluatedKey: undefined });

    const writePk = [THREAD_ID, 'ckpt-1', ''].join(SEPARATOR);
    ddb.mock
      .on(QueryCommand, {
        TableName: WRITES_TABLE,
        KeyConditionExpression: 'thread_id_checkpoint_id_checkpoint_ns = :pk',
        ExpressionAttributeValues: { ':pk': writePk },
        ExclusiveStartKey: undefined,
      })
      .resolves({ Items: [], LastEvaluatedKey: undefined });

    ddb.mock.on(BatchWriteCommand).resolves({});
    const deleteBatch = jest.fn(async () => undefined);

    await deleteThreadAction(
      makeParams({
        client: ddb.mock as unknown as DeleteThreadActionParams['client'],
        s3Offloader: {
          deleteBatch,
        } as unknown as NonNullable<DeleteThreadActionParams['s3Offloader']>,
      }),
    );

    expect(deleteBatch).not.toHaveBeenCalled();
  });

  it('aborts for safety when the thread exceeds the MAX_DELETE_BATCH_SIZE item cap', async () => {
    // Guards line 74: once accumulated items exceed MAX_DELETE_BATCH_SIZE
    // (100_000), the delete must throw BEFORE any batch write rather than load an
    // unbounded set into memory.
    const OVER_CAP = 100_001;
    const bigPage = Array.from({ length: OVER_CAP }, (_v, i) => metadataItem(`ckpt-${i}`));
    ddb.mock
      .on(QueryCommand, {
        TableName: CHECKPOINTS_TABLE,
        KeyConditionExpression: 'thread_id = :thread_id',
        ExpressionAttributeValues: { ':thread_id': THREAD_ID },
        ExclusiveStartKey: undefined,
      })
      .resolves({ Items: bigPage, LastEvaluatedKey: undefined });

    await expect(
      deleteThreadAction(
        makeParams({ client: ddb.mock as unknown as DeleteThreadActionParams['client'] }),
      ),
    ).rejects.toThrow('Thread has too many items (>100000)');

    // The safety abort happens before any batch write.
    expect(ddb.mock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
  });

  it('paginates the per-checkpoint writes Query across an empty page carrying a LastEvaluatedKey', async () => {
    // Guards the do/while in queryAllWritesForCheckpoint: an empty writes page
    // with LastEvaluatedKey must trigger a second writes Query (ExclusiveStartKey
    // set) before the writes are collected.
    ddb.mock
      .on(QueryCommand, {
        TableName: CHECKPOINTS_TABLE,
        KeyConditionExpression: 'thread_id = :thread_id',
        ExpressionAttributeValues: { ':thread_id': THREAD_ID },
        ExclusiveStartKey: undefined,
      })
      .resolves({ Items: [metadataItem('ckpt-1')], LastEvaluatedKey: undefined });

    const writePk = [THREAD_ID, 'ckpt-1', ''].join(SEPARATOR);
    const writesCursor = {
      thread_id_checkpoint_id_checkpoint_ns: writePk,
      task_id_idx: 'task-1:::0',
    };
    ddb.mock
      .on(QueryCommand, {
        TableName: WRITES_TABLE,
        KeyConditionExpression: 'thread_id_checkpoint_id_checkpoint_ns = :pk',
        ExpressionAttributeValues: { ':pk': writePk },
        ExclusiveStartKey: undefined,
      })
      .resolves({ Items: [], LastEvaluatedKey: writesCursor });
    ddb.mock
      .on(QueryCommand, {
        TableName: WRITES_TABLE,
        KeyConditionExpression: 'thread_id_checkpoint_id_checkpoint_ns = :pk',
        ExpressionAttributeValues: { ':pk': writePk },
        ExclusiveStartKey: writesCursor,
      })
      .resolves({
        Items: [{ thread_id_checkpoint_id_checkpoint_ns: writePk, task_id_idx: 'task-1:::0' }],
        LastEvaluatedKey: undefined,
      });

    ddb.mock.on(BatchWriteCommand).resolves({});

    await deleteThreadAction(
      makeParams({ client: ddb.mock as unknown as DeleteThreadActionParams['client'] }),
    );

    // 1 checkpoints page + 2 writes pages.
    expect(ddb.mock.commandCalls(QueryCommand)).toHaveLength(3);
    // The writes delete BatchWrite carries the single collected write.
    const batchCalls = ddb.mock.commandCalls(BatchWriteCommand);
    expect(batchCalls[1].args[0].input).toEqual({
      RequestItems: {
        [WRITES_TABLE]: [
          {
            DeleteRequest: {
              Key: {
                thread_id_checkpoint_id_checkpoint_ns: writePk,
                task_id_idx: 'task-1:::0',
              },
            },
          },
        ],
      },
    });
  });
});
