/**
 * Strict unit tests for putWritesAction (src/checkpointer/actions/put-writes.ts).
 *
 * Characterizes the existing, assumed-correct source: exact BatchWriteCommand
 * shape (composite keys, ttl), validation throws, missing checkpoint_id, and
 * AbortSignal short-circuit (zero DDB calls on a pre-aborted signal).
 */
import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import { putWritesAction } from '../../../../src/checkpointer/actions/put-writes';
import type { PutWritesActionParams } from '../../../../src/checkpointer/types';
import { THREAD_ID } from '../../../shared/fixtures/test-data';
import { preAbortedSignal } from '../../../shared/helpers/abort';
import { EXPECTED_TTL_30D, FROZEN_NOW_MS } from '../../../shared/helpers/frozen-time';
import { expectNoUnexpectedCommands } from '../../../shared/helpers/strict-ddb-assertions';
import { createStrictDdbMock, type StrictDdbMock } from '../../../shared/mocks/dynamodb';

const CHECKPOINT_ID = 'ckpt-1';
const TASK_ID = 'task-1';
const WRITES_TABLE = 'writes-table';
const SEPARATOR = ':::';

/** Deterministic serde: dumpsTyped returns a stable type + UTF-8 bytes of JSON. */
function makeSerde(): SerializerProtocol {
  return {
    dumpsTyped: (value: unknown): [string, Uint8Array] => [
      'json',
      new TextEncoder().encode(JSON.stringify(value)),
    ],
    loadsTyped: async (_type: string, data: Uint8Array): Promise<unknown> =>
      JSON.parse(new TextDecoder().decode(data)),
  } as unknown as SerializerProtocol;
}

function makeParams(overrides: Partial<PutWritesActionParams> = {}): PutWritesActionParams {
  const ddb = (overrides as { client?: unknown }).client;
  return {
    client: ddb as PutWritesActionParams['client'],
    writesTableName: WRITES_TABLE,
    serde: makeSerde(),
    config: {
      configurable: {
        thread_id: THREAD_ID,
        checkpoint_ns: '',
        checkpoint_id: CHECKPOINT_ID,
      },
    },
    writes: [['channel-a', { v: 1 }]],
    taskId: TASK_ID,
    ...overrides,
  };
}

describe('putWritesAction', () => {
  let ddb: StrictDdbMock;

  beforeEach(() => {
    ddb = createStrictDdbMock();
  });

  afterEach(() => {
    ddb.mock.restore();
  });

  it('writes a single pending write via BatchWriteCommand with the exact composite keys and ttl', async () => {
    ddb.mock.on(BatchWriteCommand).resolves({});

    await putWritesAction(
      makeParams({
        client: ddb.mock as unknown as PutWritesActionParams['client'],
        ttlDays: 30,
      }),
    );

    const partitionKey = [THREAD_ID, CHECKPOINT_ID, ''].join(SEPARATOR);
    const calls = ddb.mock.commandCalls(BatchWriteCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toEqual({
      RequestItems: {
        [WRITES_TABLE]: [
          {
            PutRequest: {
              Item: {
                thread_id_checkpoint_id_checkpoint_ns: partitionKey,
                task_id_idx: `${TASK_ID}${SEPARATOR}0`,
                channel: 'channel-a',
                type: 'json',
                value: new TextEncoder().encode(JSON.stringify({ v: 1 })),
                ttl: EXPECTED_TTL_30D,
              },
            },
          },
        ],
      },
    });
    expectNoUnexpectedCommands(ddb.mock, [BatchWriteCommand]);
  }); // AC-11

  it('omits the ttl attribute from the write item when no ttl option is set', async () => {
    ddb.mock.on(BatchWriteCommand).resolves({});

    await putWritesAction(
      makeParams({ client: ddb.mock as unknown as PutWritesActionParams['client'] }),
    );

    const item = (
      ddb.mock.commandCalls(BatchWriteCommand)[0].args[0].input.RequestItems as Record<
        string,
        Array<{ PutRequest: { Item: Record<string, unknown> } }>
      >
    )[WRITES_TABLE][0].PutRequest.Item;
    expect(item).not.toHaveProperty('ttl');
    expect(item).not.toHaveProperty('s3_value_key');
  }); // AC-11

  it('throws "Missing checkpoint_id" and issues no DDB command when checkpoint_id is absent', async () => {
    const params = makeParams({
      client: ddb.mock as unknown as PutWritesActionParams['client'],
      config: { configurable: { thread_id: THREAD_ID, checkpoint_ns: '' } },
    });

    await expect(putWritesAction(params)).rejects.toThrow('Missing checkpoint_id');
    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-8

  it('rejects an empty task id via validateTaskId and issues no DDB command', async () => {
    const params = makeParams({
      client: ddb.mock as unknown as PutWritesActionParams['client'],
      taskId: '',
    });

    await expect(putWritesAction(params)).rejects.toThrow('task_id cannot be empty');
    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-8

  it('rejects with the abort reason and issues zero DDB calls on a pre-aborted signal', async () => {
    const reason = new Error('cancelled-by-caller');
    const params = makeParams({
      client: ddb.mock as unknown as PutWritesActionParams['client'],
      signal: preAbortedSignal(reason),
    });

    await expect(putWritesAction(params)).rejects.toBe(reason);
    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-18

  it('computes the ttl from ttlSeconds (taking precedence over ttlDays) at the frozen epoch', async () => {
    // Guards line 37: ttlSeconds must be used (and take precedence over ttlDays)
    // to compute the item ttl = floor(now/1000) + ttlSeconds.
    ddb.mock.on(BatchWriteCommand).resolves({});

    await putWritesAction(
      makeParams({
        client: ddb.mock as unknown as PutWritesActionParams['client'],
        ttlSeconds: 120,
        ttlDays: 30, // must be IGNORED because ttlSeconds takes precedence
      }),
    );

    const expectedTtl = Math.floor(FROZEN_NOW_MS / 1000) + 120;
    const item = (
      ddb.mock.commandCalls(BatchWriteCommand)[0].args[0].input.RequestItems as Record<
        string,
        Array<{ PutRequest: { Item: Record<string, unknown> } }>
      >
    )[WRITES_TABLE][0].PutRequest.Item;
    expect(item.ttl).toBe(expectedTtl);
    expect(item.ttl).not.toBe(EXPECTED_TTL_30D);
  });

  it('offloads an oversized write value to S3 and stores an empty placeholder + s3_value_key', async () => {
    // Guards lines 63-67: when the offloader says shouldOffload, the serialized
    // value is uploaded to S3, an empty Uint8Array placeholder is stored, and
    // s3_value_key is set on the DynamoDB item.
    ddb.mock.on(BatchWriteCommand).resolves({});
    const upload = jest.fn(async () => 's3://bucket/write-key');
    const buildKey = jest.fn(
      (threadId: string, checkpointId: string, field: string) =>
        `${threadId}/${checkpointId}/${field}`,
    );
    const s3Offloader = {
      shouldOffload: () => true,
      buildKey,
      upload,
    } as unknown as NonNullable<PutWritesActionParams['s3Offloader']>;

    await putWritesAction(
      makeParams({
        client: ddb.mock as unknown as PutWritesActionParams['client'],
        s3Offloader,
      }),
    );

    expect(buildKey).toHaveBeenCalledWith(THREAD_ID, CHECKPOINT_ID, 'write-0');
    expect(upload).toHaveBeenCalledTimes(1);
    const item = (
      ddb.mock.commandCalls(BatchWriteCommand)[0].args[0].input.RequestItems as Record<
        string,
        Array<{ PutRequest: { Item: Record<string, unknown> } }>
      >
    )[WRITES_TABLE][0].PutRequest.Item;
    expect(item.s3_value_key).toBe('s3://bucket/write-key');
    expect(item.value).toEqual(new Uint8Array(0));
  });

  it('does NOT offload (no upload, no s3_value_key) when shouldOffload returns false', async () => {
    // Guards the false arm of the shouldOffload branch: the inline serialized
    // value is stored and no S3 upload happens.
    ddb.mock.on(BatchWriteCommand).resolves({});
    const upload = jest.fn(async () => 's3://bucket/write-key');
    const s3Offloader = {
      shouldOffload: () => false,
      buildKey: jest.fn(),
      upload,
    } as unknown as NonNullable<PutWritesActionParams['s3Offloader']>;

    await putWritesAction(
      makeParams({
        client: ddb.mock as unknown as PutWritesActionParams['client'],
        s3Offloader,
      }),
    );

    expect(upload).not.toHaveBeenCalled();
    const item = (
      ddb.mock.commandCalls(BatchWriteCommand)[0].args[0].input.RequestItems as Record<
        string,
        Array<{ PutRequest: { Item: Record<string, unknown> } }>
      >
    )[WRITES_TABLE][0].PutRequest.Item;
    expect(item).not.toHaveProperty('s3_value_key');
    expect(item.value).toEqual(new TextEncoder().encode(JSON.stringify({ v: 1 })));
  });

  it('best-effort cleans up uploaded S3 objects (deleteBatch) and re-throws when the batch write fails', async () => {
    // Guards lines 98-101: when batchWriteAllWithRetry throws and an offloader is
    // present, the uploaded S3 keys are passed to cleanUpS3Orphans (deleteBatch),
    // then the original error is re-thrown.
    const batchErr = Object.assign(new Error('The conditional request failed'), {
      name: 'ConditionalCheckFailedException',
    });
    ddb.mock.on(BatchWriteCommand).rejects(batchErr);
    const upload = jest.fn(async () => 's3://bucket/write-key');
    const deleteBatch = jest.fn(async () => undefined);
    const s3Offloader = {
      shouldOffload: () => true,
      buildKey: (t: string, c: string, f: string) => `${t}/${c}/${f}`,
      upload,
      deleteBatch,
    } as unknown as NonNullable<PutWritesActionParams['s3Offloader']>;

    await expect(
      putWritesAction(
        makeParams({
          client: ddb.mock as unknown as PutWritesActionParams['client'],
          s3Offloader,
        }),
      ),
    ).rejects.toBe(batchErr);

    expect(deleteBatch).toHaveBeenCalledTimes(1);
    expect(deleteBatch).toHaveBeenCalledWith(['s3://bucket/write-key']);
  });

  it('re-throws a failed batch write without any S3 cleanup when no offloader is configured', async () => {
    // Guards the false arm of the catch-block offloader branch: with no
    // offloader, the error simply propagates and no deleteBatch occurs.
    const batchErr = Object.assign(new Error('Rate exceeded permanently'), {
      name: 'ProvisionedThroughputExceededException',
    });
    jest.useRealTimers();
    ddb.mock.on(BatchWriteCommand).rejects(batchErr);

    await expect(
      putWritesAction(
        makeParams({ client: ddb.mock as unknown as PutWritesActionParams['client'] }),
      ),
    ).rejects.toBe(batchErr);
  });
});
