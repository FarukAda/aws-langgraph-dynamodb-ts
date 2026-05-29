/**
 * Strict unit tests for getTupleAction (src/checkpointer/actions/get-tuple.ts).
 *
 * Characterizes the existing, assumed-correct source: exact GetCommand /
 * QueryCommand shapes (ConsistentRead, payload SK prefix, writes partition key,
 * pagination ExclusiveStartKey), the deserialized tuple, the documented
 * "payload item not found" and "S3 key but no offloader" throws, and the
 * pre-aborted-signal short-circuit (zero DDB calls).
 */
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import { getTupleAction } from '../../../../src/checkpointer/actions/get-tuple';
import type { CheckpointItem, GetTupleActionParams } from '../../../../src/checkpointer/types';
import { THREAD_ID } from '../../../shared/fixtures/test-data';
import { preAbortedSignal } from '../../../shared/helpers/abort';
import { expectNoUnexpectedCommands } from '../../../shared/helpers/strict-ddb-assertions';
import { createStrictDdbMock, type StrictDdbMock } from '../../../shared/mocks/dynamodb';

const CHECKPOINT_ID = 'ckpt-1';
const CHECKPOINTS_TABLE = 'checkpoints-table';
const WRITES_TABLE = 'writes-table';
const PAYLOAD_SK_PREFIX = 'PAYLOAD#';
const SEPARATOR = ':::';
const METADATA_BYTES = new TextEncoder().encode('meta');
const PAYLOAD_BYTES = new TextEncoder().encode('payload');

/** Deterministic serde whose loadsTyped tags its output so the tuple is assertable. */
function makeSerde(): SerializerProtocol {
  return {
    dumpsTyped: (_v: unknown): [string, Uint8Array] => ['json', new Uint8Array(0)],
    loadsTyped: async (_type: string, data: Uint8Array): Promise<unknown> => ({
      decodedLength: data.length,
    }),
  } as unknown as SerializerProtocol;
}

/** A split-format metadata item (no inline checkpoint, no S3 pointer). */
function metadataItem(overrides: Partial<CheckpointItem> = {}): CheckpointItem {
  return {
    thread_id: THREAD_ID,
    checkpoint_ns: '',
    checkpoint_id: CHECKPOINT_ID,
    type: 'json',
    metadata: METADATA_BYTES,
    ...overrides,
  };
}

function makeParams(overrides: Partial<GetTupleActionParams> = {}): GetTupleActionParams {
  return {
    client: undefined as unknown as GetTupleActionParams['client'],
    checkpointsTableName: CHECKPOINTS_TABLE,
    writesTableName: WRITES_TABLE,
    serde: makeSerde(),
    config: {
      configurable: { thread_id: THREAD_ID, checkpoint_ns: '', checkpoint_id: CHECKPOINT_ID },
    },
    ...overrides,
  };
}

describe('getTupleAction', () => {
  let ddb: StrictDdbMock;

  beforeEach(() => {
    ddb = createStrictDdbMock();
  });

  afterEach(() => {
    ddb.mock.restore();
  });

  it('fetches metadata (Get, ConsistentRead) + payload (PAYLOAD# Get) + writes (Query) with exact inputs and returns the tuple', async () => {
    ddb.mock
      .on(GetCommand, {
        TableName: CHECKPOINTS_TABLE,
        Key: { thread_id: THREAD_ID, checkpoint_id: CHECKPOINT_ID },
        ConsistentRead: true,
      })
      .resolves({ Item: metadataItem() });
    ddb.mock
      .on(GetCommand, {
        TableName: CHECKPOINTS_TABLE,
        Key: { thread_id: THREAD_ID, checkpoint_id: `${PAYLOAD_SK_PREFIX}${CHECKPOINT_ID}` },
        ConsistentRead: true,
      })
      .resolves({
        Item: {
          thread_id: THREAD_ID,
          checkpoint_id: `${PAYLOAD_SK_PREFIX}${CHECKPOINT_ID}`,
          checkpoint: PAYLOAD_BYTES,
        },
      });
    ddb.mock.on(QueryCommand).resolves({ Items: [] });

    const tuple = await getTupleAction(
      makeParams({ client: ddb.mock as unknown as GetTupleActionParams['client'] }),
    );

    // Metadata Get
    const gets = ddb.mock.commandCalls(GetCommand);
    expect(gets).toHaveLength(2);
    expect(gets[0].args[0].input).toEqual({
      TableName: CHECKPOINTS_TABLE,
      Key: { thread_id: THREAD_ID, checkpoint_id: CHECKPOINT_ID },
      ConsistentRead: true,
    });
    // Payload Get (PAYLOAD#<id>)
    expect(gets[1].args[0].input).toEqual({
      TableName: CHECKPOINTS_TABLE,
      Key: { thread_id: THREAD_ID, checkpoint_id: `${PAYLOAD_SK_PREFIX}${CHECKPOINT_ID}` },
      ConsistentRead: true,
    });
    // Writes Query with composite partition key + ConsistentRead + first-page ExclusiveStartKey
    const queries = ddb.mock.commandCalls(QueryCommand);
    expect(queries).toHaveLength(1);
    expect(queries[0].args[0].input).toEqual({
      TableName: WRITES_TABLE,
      KeyConditionExpression:
        'thread_id_checkpoint_id_checkpoint_ns = :thread_id_checkpoint_id_checkpoint_ns',
      ExpressionAttributeValues: {
        ':thread_id_checkpoint_id_checkpoint_ns': [THREAD_ID, CHECKPOINT_ID, ''].join(SEPARATOR),
      },
      ConsistentRead: true,
      ExclusiveStartKey: undefined,
    });
    expect(tuple).toEqual({
      config: {
        configurable: { thread_id: THREAD_ID, checkpoint_ns: '', checkpoint_id: CHECKPOINT_ID },
      },
      checkpoint: { decodedLength: PAYLOAD_BYTES.length },
      metadata: { decodedLength: METADATA_BYTES.length },
      parentConfig: undefined,
      pendingWrites: [],
    });
    expectNoUnexpectedCommands(ddb.mock, [GetCommand, QueryCommand]);
  }); // AC-7

  it('returns undefined and issues no payload/writes calls when the metadata item is absent', async () => {
    ddb.mock.on(GetCommand).resolves({ Item: undefined });

    const tuple = await getTupleAction(
      makeParams({ client: ddb.mock as unknown as GetTupleActionParams['client'] }),
    );

    expect(tuple).toBeUndefined();
    expect(ddb.mock.commandCalls(GetCommand)).toHaveLength(1);
    expectNoUnexpectedCommands(ddb.mock, [GetCommand]);
  }); // AC-7

  it('throws the documented "Checkpoint payload item not found" error when the split payload row is missing', async () => {
    ddb.mock
      .on(GetCommand, {
        TableName: CHECKPOINTS_TABLE,
        Key: { thread_id: THREAD_ID, checkpoint_id: CHECKPOINT_ID },
        ConsistentRead: true,
      })
      .resolves({ Item: metadataItem() });
    ddb.mock
      .on(GetCommand, {
        TableName: CHECKPOINTS_TABLE,
        Key: { thread_id: THREAD_ID, checkpoint_id: `${PAYLOAD_SK_PREFIX}${CHECKPOINT_ID}` },
        ConsistentRead: true,
      })
      .resolves({ Item: undefined });

    await expect(
      getTupleAction(makeParams({ client: ddb.mock as unknown as GetTupleActionParams['client'] })),
    ).rejects.toThrow(
      `Checkpoint payload item not found for thread_id=${THREAD_ID}, checkpoint_id=${CHECKPOINT_ID}`,
    );
  }); // AC-8

  it('throws when a pending write references an S3 key but no S3 offloader is configured', async () => {
    ddb.mock
      .on(GetCommand, {
        TableName: CHECKPOINTS_TABLE,
        Key: { thread_id: THREAD_ID, checkpoint_id: CHECKPOINT_ID },
        ConsistentRead: true,
      })
      .resolves({ Item: metadataItem({ checkpoint: PAYLOAD_BYTES }) });
    ddb.mock.on(QueryCommand).resolves({
      Items: [
        {
          thread_id_checkpoint_id_checkpoint_ns: [THREAD_ID, CHECKPOINT_ID, ''].join(SEPARATOR),
          task_id_idx: `task-1${SEPARATOR}0`,
          channel: 'channel-a',
          type: 'json',
          value: new Uint8Array(0),
          s3_value_key: 's3://bucket/write-0',
        },
      ],
    });

    await expect(
      getTupleAction(makeParams({ client: ddb.mock as unknown as GetTupleActionParams['client'] })),
    ).rejects.toThrow("Pending write references S3 key 's3://bucket/write-0'");
  }); // AC-8

  it('rejects with the abort reason and issues zero DDB calls on a pre-aborted signal', async () => {
    const reason = new Error('cancelled-by-caller');
    const params = makeParams({
      client: ddb.mock as unknown as GetTupleActionParams['client'],
      signal: preAbortedSignal(reason),
    });

    await expect(getTupleAction(params)).rejects.toBe(reason);
    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-18

  // --- latest-checkpoint Query path (checkpoint_id absent) ---

  it('queries newest metadata (Descending, attribute_exists(#type), no ns filter) when checkpoint_id is omitted', async () => {
    // Guards: the no-checkpoint_id branch must Query (not Get) the checkpoints
    // table with ScanIndexForward:false and an attribute_exists(#type) filter,
    // and must NOT include a checkpoint_ns filter when ns is empty.
    ddb.mock
      .on(QueryCommand, {
        TableName: CHECKPOINTS_TABLE,
        KeyConditionExpression: 'thread_id = :thread_id',
        ExpressionAttributeValues: { ':thread_id': THREAD_ID },
        ExpressionAttributeNames: { '#type': 'type' },
        FilterExpression: 'attribute_exists(#type)',
        ConsistentRead: true,
        ScanIndexForward: false,
        ExclusiveStartKey: undefined,
      })
      .resolves({ Items: [metadataItem()], LastEvaluatedKey: undefined });
    // Payload Get for the resolved metadata.
    ddb.mock
      .on(GetCommand, {
        TableName: CHECKPOINTS_TABLE,
        Key: { thread_id: THREAD_ID, checkpoint_id: `${PAYLOAD_SK_PREFIX}${CHECKPOINT_ID}` },
        ConsistentRead: true,
      })
      .resolves({
        Item: {
          thread_id: THREAD_ID,
          checkpoint_id: `${PAYLOAD_SK_PREFIX}${CHECKPOINT_ID}`,
          checkpoint: PAYLOAD_BYTES,
        },
      });
    // Writes Query for the checkpoint.
    ddb.mock
      .on(QueryCommand, {
        TableName: WRITES_TABLE,
        KeyConditionExpression:
          'thread_id_checkpoint_id_checkpoint_ns = :thread_id_checkpoint_id_checkpoint_ns',
        ExpressionAttributeValues: {
          ':thread_id_checkpoint_id_checkpoint_ns': [THREAD_ID, CHECKPOINT_ID, ''].join(SEPARATOR),
        },
        ConsistentRead: true,
        ExclusiveStartKey: undefined,
      })
      .resolves({ Items: [] });

    const tuple = await getTupleAction(
      makeParams({
        client: ddb.mock as unknown as GetTupleActionParams['client'],
        config: { configurable: { thread_id: THREAD_ID, checkpoint_ns: '' } },
      }),
    );

    expect(tuple).toEqual({
      config: {
        configurable: { thread_id: THREAD_ID, checkpoint_ns: '', checkpoint_id: CHECKPOINT_ID },
      },
      checkpoint: { decodedLength: PAYLOAD_BYTES.length },
      metadata: { decodedLength: METADATA_BYTES.length },
      parentConfig: undefined,
      pendingWrites: [],
    });
    expectNoUnexpectedCommands(ddb.mock, [QueryCommand, GetCommand]);
  });

  it('adds the checkpoint_ns FilterExpression term and :checkpoint_ns value when a non-empty namespace is supplied', async () => {
    // Guards the hasNsFilter branch: a truthy checkpoint_ns must append
    // "checkpoint_ns = :checkpoint_ns" to the filter and the EAV.
    const NS = 'ns-a';
    ddb.mock
      .on(QueryCommand, {
        TableName: CHECKPOINTS_TABLE,
        KeyConditionExpression: 'thread_id = :thread_id',
        ExpressionAttributeValues: { ':thread_id': THREAD_ID, ':checkpoint_ns': NS },
        ExpressionAttributeNames: { '#type': 'type' },
        FilterExpression: 'attribute_exists(#type) AND checkpoint_ns = :checkpoint_ns',
        ConsistentRead: true,
        ScanIndexForward: false,
        ExclusiveStartKey: undefined,
      })
      .resolves({ Items: [metadataItem({ checkpoint_ns: NS })], LastEvaluatedKey: undefined });
    ddb.mock
      .on(GetCommand, {
        TableName: CHECKPOINTS_TABLE,
        Key: { thread_id: THREAD_ID, checkpoint_id: `${PAYLOAD_SK_PREFIX}${CHECKPOINT_ID}` },
        ConsistentRead: true,
      })
      .resolves({
        Item: {
          thread_id: THREAD_ID,
          checkpoint_id: `${PAYLOAD_SK_PREFIX}${CHECKPOINT_ID}`,
          checkpoint: PAYLOAD_BYTES,
        },
      });
    ddb.mock
      .on(QueryCommand, {
        TableName: WRITES_TABLE,
        KeyConditionExpression:
          'thread_id_checkpoint_id_checkpoint_ns = :thread_id_checkpoint_id_checkpoint_ns',
        ExpressionAttributeValues: {
          ':thread_id_checkpoint_id_checkpoint_ns': [THREAD_ID, CHECKPOINT_ID, NS].join(SEPARATOR),
        },
        ConsistentRead: true,
        ExclusiveStartKey: undefined,
      })
      .resolves({ Items: [] });

    const tuple = await getTupleAction(
      makeParams({
        client: ddb.mock as unknown as GetTupleActionParams['client'],
        config: { configurable: { thread_id: THREAD_ID, checkpoint_ns: NS } },
      }),
    );

    expect(tuple).toBeDefined();
    // Two QueryCommands: the metadata query (with ns filter) + the writes query.
    const metaQuery = ddb.mock.commandCalls(QueryCommand)[0].args[0].input;
    expect(metaQuery.FilterExpression).toBe(
      'attribute_exists(#type) AND checkpoint_ns = :checkpoint_ns',
    );
    expect(metaQuery.ExpressionAttributeValues).toEqual({
      ':thread_id': THREAD_ID,
      ':checkpoint_ns': NS,
    });
  });

  it('continues paginating the metadata Query across an empty page carrying a LastEvaluatedKey', async () => {
    // Guards the do/while metadata pagination: an empty Items page that still
    // carries LastEvaluatedKey must NOT stop the loop; the next page (with the
    // ExclusiveStartKey set) must be queried.
    const cursor = { thread_id: THREAD_ID, checkpoint_id: 'cursor-1' };
    ddb.mock
      .on(QueryCommand, {
        TableName: CHECKPOINTS_TABLE,
        KeyConditionExpression: 'thread_id = :thread_id',
        ExpressionAttributeValues: { ':thread_id': THREAD_ID },
        ExpressionAttributeNames: { '#type': 'type' },
        FilterExpression: 'attribute_exists(#type)',
        ConsistentRead: true,
        ScanIndexForward: false,
        ExclusiveStartKey: undefined,
      })
      .resolves({ Items: [], LastEvaluatedKey: cursor });
    ddb.mock
      .on(QueryCommand, {
        TableName: CHECKPOINTS_TABLE,
        KeyConditionExpression: 'thread_id = :thread_id',
        ExpressionAttributeValues: { ':thread_id': THREAD_ID },
        ExpressionAttributeNames: { '#type': 'type' },
        FilterExpression: 'attribute_exists(#type)',
        ConsistentRead: true,
        ScanIndexForward: false,
        ExclusiveStartKey: cursor,
      })
      .resolves({ Items: [metadataItem()], LastEvaluatedKey: undefined });
    ddb.mock
      .on(GetCommand, {
        TableName: CHECKPOINTS_TABLE,
        Key: { thread_id: THREAD_ID, checkpoint_id: `${PAYLOAD_SK_PREFIX}${CHECKPOINT_ID}` },
        ConsistentRead: true,
      })
      .resolves({
        Item: {
          thread_id: THREAD_ID,
          checkpoint_id: `${PAYLOAD_SK_PREFIX}${CHECKPOINT_ID}`,
          checkpoint: PAYLOAD_BYTES,
        },
      });
    ddb.mock
      .on(QueryCommand, {
        TableName: WRITES_TABLE,
        KeyConditionExpression:
          'thread_id_checkpoint_id_checkpoint_ns = :thread_id_checkpoint_id_checkpoint_ns',
        ExpressionAttributeValues: {
          ':thread_id_checkpoint_id_checkpoint_ns': [THREAD_ID, CHECKPOINT_ID, ''].join(SEPARATOR),
        },
        ConsistentRead: true,
        ExclusiveStartKey: undefined,
      })
      .resolves({ Items: [] });

    const tuple = await getTupleAction(
      makeParams({
        client: ddb.mock as unknown as GetTupleActionParams['client'],
        config: { configurable: { thread_id: THREAD_ID, checkpoint_ns: '' } },
      }),
    );

    expect(tuple).toBeDefined();
    // Two metadata pages + one writes query.
    expect(ddb.mock.commandCalls(QueryCommand)).toHaveLength(3);
  });

  it('returns undefined when the metadata Query exhausts all pages without a match', async () => {
    // Guards the `return undefined` after the metadata pagination loop: an empty
    // final page (no LastEvaluatedKey) yields undefined and no payload/writes call.
    ddb.mock
      .on(QueryCommand, {
        TableName: CHECKPOINTS_TABLE,
        KeyConditionExpression: 'thread_id = :thread_id',
        ExpressionAttributeValues: { ':thread_id': THREAD_ID },
        ExpressionAttributeNames: { '#type': 'type' },
        FilterExpression: 'attribute_exists(#type)',
        ConsistentRead: true,
        ScanIndexForward: false,
        ExclusiveStartKey: undefined,
      })
      .resolves({ Items: [], LastEvaluatedKey: undefined });

    const tuple = await getTupleAction(
      makeParams({
        client: ddb.mock as unknown as GetTupleActionParams['client'],
        config: { configurable: { thread_id: THREAD_ID, checkpoint_ns: '' } },
      }),
    );

    expect(tuple).toBeUndefined();
    expect(ddb.mock.commandCalls(QueryCommand)).toHaveLength(1);
    expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
  });

  // --- S3-offloaded checkpoint metadata (skip payload Get) ---

  it('skips the payload Get and uses an empty placeholder when the metadata item carries s3_checkpoint_key', async () => {
    // Guards line 111: when s3_checkpoint_key is present, getTuple must NOT issue
    // the PAYLOAD# Get — deserializeCheckpointTuple downloads from S3 instead.
    const downloadedCheckpoint = new TextEncoder().encode('s3-checkpoint');
    const downloadedMetadata = new TextEncoder().encode('s3-metadata-bytes');
    const download = jest.fn(async (key: string) =>
      key === 's3://bucket/ckpt' ? downloadedCheckpoint : downloadedMetadata,
    );
    const s3Offloader = {
      download,
    } as unknown as NonNullable<GetTupleActionParams['s3Offloader']>;

    ddb.mock
      .on(GetCommand, {
        TableName: CHECKPOINTS_TABLE,
        Key: { thread_id: THREAD_ID, checkpoint_id: CHECKPOINT_ID },
        ConsistentRead: true,
      })
      .resolves({
        Item: metadataItem({
          metadata: undefined,
          s3_checkpoint_key: 's3://bucket/ckpt',
          s3_metadata_key: 's3://bucket/meta',
        }),
      });
    ddb.mock.on(QueryCommand).resolves({ Items: [] });

    const tuple = await getTupleAction(
      makeParams({ client: ddb.mock as unknown as GetTupleActionParams['client'], s3Offloader }),
    );

    // Only the metadata Get — the PAYLOAD# Get must be absent.
    expect(ddb.mock.commandCalls(GetCommand)).toHaveLength(1);
    // deserializeCheckpointTuple downloaded the real checkpoint bytes from S3.
    expect(tuple?.checkpoint).toEqual({ decodedLength: downloadedCheckpoint.length });
    expect(download).toHaveBeenCalledWith('s3://bucket/ckpt');
    expectNoUnexpectedCommands(ddb.mock, [GetCommand, QueryCommand]);
  });

  // --- pending-write S3 download + decompress + writes pagination ---

  it('downloads an S3-offloaded pending write, decompresses it, and includes it in pendingWrites', async () => {
    // Guards lines 187-193: when a write has s3_value_key and an offloader is
    // configured, the value is downloaded then run through compressor.decompress
    // before serde.loadsTyped.
    const downloaded = new TextEncoder().encode('compressed-write');
    const decompressed = new TextEncoder().encode('plain-write-bytes');
    const download = jest.fn(async () => downloaded);
    const decompress = jest.fn(async () => decompressed);

    ddb.mock
      .on(GetCommand, {
        TableName: CHECKPOINTS_TABLE,
        Key: { thread_id: THREAD_ID, checkpoint_id: CHECKPOINT_ID },
        ConsistentRead: true,
      })
      .resolves({ Item: metadataItem({ checkpoint: PAYLOAD_BYTES }) });
    ddb.mock.on(QueryCommand).resolves({
      Items: [
        {
          thread_id_checkpoint_id_checkpoint_ns: [THREAD_ID, CHECKPOINT_ID, ''].join(SEPARATOR),
          task_id_idx: `task-7${SEPARATOR}0`,
          channel: 'channel-z',
          type: 'json',
          value: new Uint8Array(0),
          s3_value_key: 's3://bucket/write-0',
        },
      ],
    });

    const tuple = await getTupleAction(
      makeParams({
        client: ddb.mock as unknown as GetTupleActionParams['client'],
        s3Offloader: { download } as unknown as NonNullable<GetTupleActionParams['s3Offloader']>,
        compressor: { decompress } as unknown as NonNullable<GetTupleActionParams['compressor']>,
      }),
    );

    expect(download).toHaveBeenCalledWith('s3://bucket/write-0');
    // decompress runs on the S3-downloaded bytes, not the inline (empty) value.
    expect(decompress).toHaveBeenCalledWith(downloaded);
    expect(tuple?.pendingWrites).toEqual([
      ['task-7', 'channel-z', { decodedLength: decompressed.length }],
    ]);
  });

  it('paginates the writes Query across an empty page carrying a LastEvaluatedKey before returning the tuple', async () => {
    // Guards the writes do/while loop: an empty page with LastEvaluatedKey must
    // trigger a second writes Query whose ExclusiveStartKey is that cursor.
    const writesCursor = {
      thread_id_checkpoint_id_checkpoint_ns: [THREAD_ID, CHECKPOINT_ID, ''].join(SEPARATOR),
      task_id_idx: `task-1${SEPARATOR}0`,
    };
    ddb.mock
      .on(GetCommand, {
        TableName: CHECKPOINTS_TABLE,
        Key: { thread_id: THREAD_ID, checkpoint_id: CHECKPOINT_ID },
        ConsistentRead: true,
      })
      .resolves({ Item: metadataItem({ checkpoint: PAYLOAD_BYTES }) });
    ddb.mock
      .on(QueryCommand, {
        TableName: WRITES_TABLE,
        KeyConditionExpression:
          'thread_id_checkpoint_id_checkpoint_ns = :thread_id_checkpoint_id_checkpoint_ns',
        ExpressionAttributeValues: {
          ':thread_id_checkpoint_id_checkpoint_ns': [THREAD_ID, CHECKPOINT_ID, ''].join(SEPARATOR),
        },
        ConsistentRead: true,
        ExclusiveStartKey: undefined,
      })
      .resolves({ Items: [], LastEvaluatedKey: writesCursor });
    ddb.mock
      .on(QueryCommand, {
        TableName: WRITES_TABLE,
        KeyConditionExpression:
          'thread_id_checkpoint_id_checkpoint_ns = :thread_id_checkpoint_id_checkpoint_ns',
        ExpressionAttributeValues: {
          ':thread_id_checkpoint_id_checkpoint_ns': [THREAD_ID, CHECKPOINT_ID, ''].join(SEPARATOR),
        },
        ConsistentRead: true,
        ExclusiveStartKey: writesCursor,
      })
      .resolves({
        Items: [
          {
            thread_id_checkpoint_id_checkpoint_ns: [THREAD_ID, CHECKPOINT_ID, ''].join(SEPARATOR),
            task_id_idx: `task-1${SEPARATOR}0`,
            channel: 'channel-a',
            type: 'json',
            value: PAYLOAD_BYTES,
          },
        ],
        LastEvaluatedKey: undefined,
      });

    const tuple = await getTupleAction(
      makeParams({ client: ddb.mock as unknown as GetTupleActionParams['client'] }),
    );

    expect(ddb.mock.commandCalls(QueryCommand)).toHaveLength(2);
    expect(tuple?.pendingWrites).toEqual([
      ['task-1', 'channel-a', { decodedLength: PAYLOAD_BYTES.length }],
    ]);
  });

  it('surfaces a non-retryable ResourceNotFoundException from the metadata Get without issuing payload/writes calls', async () => {
    // Guards error propagation through the metadata-Get retry wrapper.
    const notFound = Object.assign(new Error('Requested resource not found'), {
      name: 'ResourceNotFoundException',
    });
    ddb.mock.on(GetCommand).rejects(notFound);

    await expect(
      getTupleAction(makeParams({ client: ddb.mock as unknown as GetTupleActionParams['client'] })),
    ).rejects.toBe(notFound);

    expect(ddb.mock.commandCalls(GetCommand)).toHaveLength(1);
    expectNoUnexpectedCommands(ddb.mock, [GetCommand]);
  });
});
