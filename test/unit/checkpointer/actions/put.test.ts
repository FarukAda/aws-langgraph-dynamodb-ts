/**
 * Strict unit tests for putAction (src/checkpointer/actions/put.ts).
 *
 * Characterizes the existing, assumed-correct source: exact TransactWriteCommand
 * shape (metadata + payload Put, ConditionExpression, EAN/EAV, ttl), the
 * returned RunnableConfig, validation throws, S3 offload pointer behavior and
 * orphan-cleanup branch selection, and AbortSignal short-circuit.
 */
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import { putAction } from '../../../../src/checkpointer/actions/put';
import type { PutActionParams } from '../../../../src/checkpointer/types';
import {
  THREAD_ID,
  makeCheckpoint,
  makeCheckpointMetadata,
} from '../../../shared/fixtures/test-data';
import { preAbortedSignal } from '../../../shared/helpers/abort';
import { EXPECTED_TTL_30D, FROZEN_NOW_MS } from '../../../shared/helpers/frozen-time';
import { expectNoUnexpectedCommands } from '../../../shared/helpers/strict-ddb-assertions';
import { createStrictDdbMock, type StrictDdbMock } from '../../../shared/mocks/dynamodb';

const CHECKPOINT_ID = 'ckpt-1';
const CHECKPOINTS_TABLE = 'checkpoints-table';
const PAYLOAD_SK_PREFIX = 'PAYLOAD#';
const CHECKPOINT_BYTES = new TextEncoder().encode('checkpoint-blob');
const METADATA_BYTES = new TextEncoder().encode('metadata-blob');

/** Deterministic serde: first call returns the checkpoint bytes, second the metadata bytes. */
function makeSerde(): SerializerProtocol {
  let call = 0;
  return {
    dumpsTyped: (_value: unknown): [string, Uint8Array] => {
      call += 1;
      return ['json', call === 1 ? CHECKPOINT_BYTES : METADATA_BYTES];
    },
    loadsTyped: async (): Promise<unknown> => ({}),
  } as unknown as SerializerProtocol;
}

function makeParams(overrides: Partial<PutActionParams> = {}): PutActionParams {
  return {
    client: undefined as unknown as PutActionParams['client'],
    checkpointsTableName: CHECKPOINTS_TABLE,
    serde: makeSerde(),
    config: { configurable: { thread_id: THREAD_ID, checkpoint_ns: '' } },
    checkpoint: makeCheckpoint({ id: CHECKPOINT_ID }),
    metadata: makeCheckpointMetadata(),
    ...overrides,
  };
}

describe('putAction', () => {
  let ddb: StrictDdbMock;

  beforeEach(() => {
    ddb = createStrictDdbMock();
  });

  afterEach(() => {
    ddb.mock.restore();
  });

  it('writes metadata + payload atomically via TransactWriteCommand with exact condition, EAN/EAV and ttl', async () => {
    ddb.mock.on(TransactWriteCommand).resolves({});

    const result = await putAction(
      makeParams({
        client: ddb.mock as unknown as PutActionParams['client'],
        ttlDays: 30,
      }),
    );

    const calls = ddb.mock.commandCalls(TransactWriteCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toEqual({
      TransactItems: [
        {
          Put: {
            TableName: CHECKPOINTS_TABLE,
            Item: {
              thread_id: THREAD_ID,
              checkpoint_ns: '',
              checkpoint_id: CHECKPOINT_ID,
              parent_checkpoint_id: undefined,
              type: 'json',
              metadata: METADATA_BYTES,
              s3_checkpoint_key: undefined,
              s3_metadata_key: undefined,
              ttl: EXPECTED_TTL_30D,
            },
            ConditionExpression:
              'attribute_not_exists(checkpoint_id) OR (#type = :expected_type AND (attribute_not_exists(parent_checkpoint_id)))',
            ExpressionAttributeNames: { '#type': 'type' },
            ExpressionAttributeValues: { ':expected_type': 'json' },
          },
        },
        {
          Put: {
            TableName: CHECKPOINTS_TABLE,
            Item: {
              thread_id: THREAD_ID,
              checkpoint_id: `${PAYLOAD_SK_PREFIX}${CHECKPOINT_ID}`,
              checkpoint: CHECKPOINT_BYTES,
              ttl: EXPECTED_TTL_30D,
            },
          },
        },
      ],
    });
    expect(result).toEqual({
      configurable: {
        thread_id: THREAD_ID,
        checkpoint_ns: '',
        checkpoint_id: CHECKPOINT_ID,
      },
    });
    expectNoUnexpectedCommands(ddb.mock, [TransactWriteCommand]);
  }); // AC-12

  it('uses the named-parent ConditionExpression with :expected_parent when checkpoint_id parent is present', async () => {
    ddb.mock.on(TransactWriteCommand).resolves({});

    await putAction(
      makeParams({
        client: ddb.mock as unknown as PutActionParams['client'],
        config: {
          configurable: { thread_id: THREAD_ID, checkpoint_ns: '', checkpoint_id: 'parent-id' },
        },
      }),
    );

    const put = (
      ddb.mock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems as Array<{
        Put: {
          ConditionExpression: string;
          ExpressionAttributeValues: Record<string, unknown>;
        };
      }>
    )[0].Put;
    expect(put.ConditionExpression).toBe(
      'attribute_not_exists(checkpoint_id) OR (#type = :expected_type AND (parent_checkpoint_id = :expected_parent))',
    );
    expect(put.ExpressionAttributeValues).toEqual({
      ':expected_type': 'json',
      ':expected_parent': 'parent-id',
    });
  }); // AC-12

  it('throws "Checkpoint ID is required" and issues no DDB command when checkpoint.id is empty', async () => {
    const params = makeParams({
      client: ddb.mock as unknown as PutActionParams['client'],
      checkpoint: makeCheckpoint({ id: '' }),
    });

    await expect(putAction(params)).rejects.toThrow('Checkpoint ID is required');
    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-8

  it('offloads an oversized checkpoint to S3, stores an empty placeholder + s3_checkpoint_key, and keeps no cleanup on success', async () => {
    ddb.mock.on(TransactWriteCommand).resolves({});
    const upload = jest.fn(async () => 's3://bucket/checkpoint-key');
    const cleanUp = jest.fn(async () => undefined);
    const s3Offloader = {
      shouldOffload: (b: Uint8Array) => b === CHECKPOINT_BYTES,
      buildKey: (_t: string, _c: string, kind: string) => `key-${kind}`,
      upload,
      cleanUp,
    } as unknown as NonNullable<PutActionParams['s3Offloader']>;

    await putAction(
      makeParams({
        client: ddb.mock as unknown as PutActionParams['client'],
        s3Offloader,
      }),
    );

    expect(upload).toHaveBeenCalledTimes(1);
    const payloadPut = ddb.mock.commandCalls(TransactWriteCommand)[0].args[0].input
      .TransactItems as Array<{
      Put: { Item: Record<string, unknown> };
    }>;
    expect(payloadPut[0].Put.Item.s3_checkpoint_key).toBe('s3://bucket/checkpoint-key');
    expect(payloadPut[1].Put.Item.checkpoint).toEqual(new Uint8Array(0));
    expect(cleanUp).not.toHaveBeenCalled();
  }); // AC-12

  it('skips S3 orphan cleanup on a ConditionalCheckFailedException and re-throws the error', async () => {
    const conditionErr = Object.assign(new Error('conditional check failed'), {
      name: 'ConditionalCheckFailedException',
    });
    ddb.mock.on(TransactWriteCommand).rejects(conditionErr);
    const upload = jest.fn(async () => 's3://bucket/checkpoint-key');
    const cleanUp = jest.fn(async () => undefined);
    const s3Offloader = {
      shouldOffload: (b: Uint8Array) => b === CHECKPOINT_BYTES,
      buildKey: (_t: string, _c: string, kind: string) => `key-${kind}`,
      upload,
      cleanUp,
    } as unknown as NonNullable<PutActionParams['s3Offloader']>;

    await expect(
      putAction(
        makeParams({
          client: ddb.mock as unknown as PutActionParams['client'],
          s3Offloader,
        }),
      ),
    ).rejects.toBe(conditionErr);
    expect(cleanUp).not.toHaveBeenCalled();
  }); // AC-8

  it('throws when serde produces different types for checkpoint vs metadata and issues no DDB command', async () => {
    // dumpsTyped returns 'json' for the checkpoint then 'cbor' for the metadata:
    // the type1 !== type2 guard must reject before any write.
    let call = 0;
    const mismatchSerde = {
      dumpsTyped: (): [string, Uint8Array] => {
        call += 1;
        return [call === 1 ? 'json' : 'cbor', CHECKPOINT_BYTES];
      },
      loadsTyped: async (): Promise<unknown> => ({}),
    } as unknown as SerializerProtocol;

    await expect(
      putAction(
        makeParams({
          client: ddb.mock as unknown as PutActionParams['client'],
          serde: mismatchSerde,
        }),
      ),
    ).rejects.toThrow('Failed to serialize checkpoint and metadata to the same type.');
    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-8

  it('offloads oversized METADATA to S3, storing an empty placeholder + s3_metadata_key', async () => {
    ddb.mock.on(TransactWriteCommand).resolves({});
    const upload = jest.fn(async (key: string) => `s3://bucket/${key}`);
    const s3Offloader = {
      // Only the metadata blob exceeds the threshold here.
      shouldOffload: (b: Uint8Array) => b === METADATA_BYTES,
      buildKey: (_t: string, _c: string, kind: string) => `key-${kind}`,
      upload,
    } as unknown as NonNullable<PutActionParams['s3Offloader']>;

    await putAction(
      makeParams({ client: ddb.mock as unknown as PutActionParams['client'], s3Offloader }),
    );

    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith('key-metadata', METADATA_BYTES);
    const items = ddb.mock.commandCalls(TransactWriteCommand)[0].args[0].input
      .TransactItems as Array<{ Put: { Item: Record<string, unknown> } }>;
    // Metadata routed to S3: pointer set, in-DDB blob is the empty placeholder.
    expect(items[0].Put.Item.s3_metadata_key).toBe('s3://bucket/key-metadata');
    expect(items[0].Put.Item.metadata).toEqual(new Uint8Array(0));
    // Checkpoint stayed inline (under threshold): no checkpoint pointer.
    expect(items[0].Put.Item.s3_checkpoint_key).toBeUndefined();
    expect(items[1].Put.Item.checkpoint).toEqual(CHECKPOINT_BYTES);
  }); // AC-12

  it('derives ttl from ttlSeconds via calculateTTLTimestampFromSeconds (exact, frozen clock)', async () => {
    ddb.mock.on(TransactWriteCommand).resolves({});

    await putAction(
      makeParams({ client: ddb.mock as unknown as PutActionParams['client'], ttlSeconds: 3_600 }),
    );

    const expectedTtl = Math.floor(FROZEN_NOW_MS / 1000) + 3_600;
    const items = ddb.mock.commandCalls(TransactWriteCommand)[0].args[0].input
      .TransactItems as Array<{ Put: { Item: Record<string, unknown> } }>;
    expect(items[0].Put.Item.ttl).toBe(expectedTtl);
    expect(items[1].Put.Item.ttl).toBe(expectedTtl);
  }); // AC-12

  it('cleans up uploaded S3 orphans on a NON-conditional transaction failure, then re-throws', async () => {
    // A generic (non-retryable, non-conditional) error: the catch path must run
    // cleanUpS3Orphans for the keys we uploaded before the write failed.
    const failure = new Error('table temporarily unavailable');
    ddb.mock.on(TransactWriteCommand).rejects(failure);
    const upload = jest.fn(async () => 's3://bucket/checkpoint-key');
    const deleteBatch = jest.fn(async () => undefined);
    const s3Offloader = {
      shouldOffload: (b: Uint8Array) => b === CHECKPOINT_BYTES,
      buildKey: (_t: string, _c: string, kind: string) => `key-${kind}`,
      upload,
      deleteBatch,
    } as unknown as NonNullable<PutActionParams['s3Offloader']>;

    await expect(
      putAction(
        makeParams({ client: ddb.mock as unknown as PutActionParams['client'], s3Offloader }),
      ),
    ).rejects.toBe(failure);
    // The uploaded checkpoint key is handed to deleteBatch for best-effort cleanup.
    expect(deleteBatch).toHaveBeenCalledTimes(1);
    expect(deleteBatch).toHaveBeenCalledWith(['s3://bucket/checkpoint-key']);
  }); // AC-8

  it('compresses both blobs through the provided compressor before storing them', async () => {
    ddb.mock.on(TransactWriteCommand).resolves({});
    const COMPRESSED_CKPT = new Uint8Array([0x9c, 0x01]);
    const COMPRESSED_META = new Uint8Array([0x9c, 0x02]);
    const compress = jest.fn(async (b: Uint8Array) =>
      b === CHECKPOINT_BYTES ? COMPRESSED_CKPT : COMPRESSED_META,
    );
    const compressor = { compress } as unknown as NonNullable<PutActionParams['compressor']>;

    await putAction(
      makeParams({ client: ddb.mock as unknown as PutActionParams['client'], compressor }),
    );

    expect(compress).toHaveBeenCalledTimes(2);
    const items = ddb.mock.commandCalls(TransactWriteCommand)[0].args[0].input
      .TransactItems as Array<{ Put: { Item: Record<string, unknown> } }>;
    // The DDB items carry the COMPRESSED bytes, not the raw serde output.
    expect(items[0].Put.Item.metadata).toEqual(COMPRESSED_META);
    expect(items[1].Put.Item.checkpoint).toEqual(COMPRESSED_CKPT);
  }); // AC-12

  it('defaults checkpoint_ns to "" when the config omits it (?? fallback)', async () => {
    ddb.mock.on(TransactWriteCommand).resolves({});

    const result = await putAction(
      makeParams({
        client: ddb.mock as unknown as PutActionParams['client'],
        // No checkpoint_ns on the configurable — the source coalesces to ''.
        config: { configurable: { thread_id: THREAD_ID } },
      }),
    );

    expect(result.configurable?.checkpoint_ns).toBe('');
    const items = ddb.mock.commandCalls(TransactWriteCommand)[0].args[0].input
      .TransactItems as Array<{ Put: { Item: Record<string, unknown> } }>;
    expect(items[0].Put.Item.checkpoint_ns).toBe('');
  }); // AC-12

  it('rejects with the abort reason and issues zero DDB calls on a pre-aborted signal', async () => {
    const reason = new Error('cancelled-by-caller');
    const params = makeParams({
      client: ddb.mock as unknown as PutActionParams['client'],
      signal: preAbortedSignal(reason),
    });

    await expect(putAction(params)).rejects.toBe(reason);
    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-18
});
