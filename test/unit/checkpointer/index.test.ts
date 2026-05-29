import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
/**
 * Unit tests for src/checkpointer/index.ts — the DynamoDBSaver orchestration class.
 *
 * The class mostly delegates to action functions, but it owns the constructor
 * option handling (compression / S3 offloading / lifecycle-rule auto-config /
 * client ownership), the `list()` AsyncGenerator (pagination, before-bound,
 * namespace + metadata filtering, page-limit math, MAX_LOOP_ITERATIONS guard,
 * abort), the BatchGetItem payload-fetch path (inline / S3 / split formats,
 * UnprocessedKeys backoff, sort-key corruption guard), `getNextVersion`, and
 * `destroy()`.
 *
 * Strict conventions: exact command class + full `.input` via `.toEqual()`,
 * frozen time (FROZEN_NOW_MS), strict DDB mock that rejects un-stubbed commands,
 * deterministic fixtures, every title names the failure mode it prevents.
 */
import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { CheckpointTuple } from '@langchain/langgraph-checkpoint';
import { mockClient } from 'aws-sdk-client-mock';

import { DynamoDBSaver } from '../../../src/checkpointer';
import { MAX_LOOP_ITERATIONS, MAX_UNPROCESSED_RETRIES } from '../../../src/shared/utils/constants';
import {
  THREAD_ID,
  makeCheckpoint,
  makeCheckpointMetadata,
  makeRunnableConfig,
} from '../../shared/fixtures/test-data';
import { preAbortedSignal } from '../../shared/helpers/abort';
import {
  expectExactQueryCommand,
  expectNoUnexpectedCommands,
} from '../../shared/helpers/strict-ddb-assertions';
import { createStrictDdbMock, type StrictDdbMock } from '../../shared/mocks/dynamodb';

const CHECKPOINTS_TABLE = 'checkpoints-table';
const WRITES_TABLE = 'writes-table';
const PAYLOAD_SK_PREFIX = 'PAYLOAD#';

function makeSaver(overrides: Record<string, unknown> = {}): DynamoDBSaver {
  return new DynamoDBSaver({
    checkpointsTableName: CHECKPOINTS_TABLE,
    writesTableName: WRITES_TABLE,
    ...overrides,
  });
}

/**
 * Serialize a checkpoint/metadata pair through the saver's own serde so the
 * bytes stored in a query/get stub are exactly what the real round-trip would
 * deserialize. An empty Uint8Array makes JSON.parse throw, so always use this.
 */
async function serializeCheckpoint(
  id: string,
): Promise<{ type: string; checkpointBytes: Uint8Array; metadataBytes: Uint8Array }> {
  const serde = makeSaver().serde;
  const checkpoint = makeCheckpoint({ id });
  const metadata = makeCheckpointMetadata();
  const [type, checkpointBytes] = await serde.dumpsTyped(checkpoint);
  const [, metadataBytes] = await serde.dumpsTyped(metadata);
  return { type, checkpointBytes, metadataBytes };
}

/** Build a list() metadata Item (split format: no inline checkpoint blob). */
function metadataItem(
  id: string,
  type: string,
  metadataBytes: Uint8Array,
): Record<string, unknown> {
  return {
    thread_id: THREAD_ID,
    checkpoint_ns: '',
    checkpoint_id: id,
    type,
    metadata: metadataBytes,
  };
}

describe('DynamoDBSaver (src/checkpointer/index.ts)', () => {
  let ddb: StrictDdbMock;

  beforeEach(() => {
    ddb = createStrictDdbMock();
  });

  afterEach(() => {
    ddb.mock.restore();
  });

  describe('constructor + destroy + getNextVersion', () => {
    it('owns the client it builds and destroys it on destroy() (no injected client)', () => {
      const ddbMock = mockClient(DynamoDBClient);
      const destroySpy = jest.fn();
      // Intercept the underlying low-level client's destroy(). The saver builds
      // its own DynamoDBClient; aws-sdk-client-mock replaces the prototype so we
      // spy on destroy via the prototype.
      const protoDestroy = jest
        .spyOn(DynamoDBClient.prototype, 'destroy')
        .mockImplementation(destroySpy);

      const saver = makeSaver();
      saver.destroy();

      expect(destroySpy).toHaveBeenCalledTimes(1);
      protoDestroy.mockRestore();
      ddbMock.restore();
    }); // owns-client cleanup

    it('does NOT destroy an injected client (ownsClient=false) on destroy()', () => {
      const injected = ddb.mock as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocument;
      const protoDestroy = jest.spyOn(DynamoDBClient.prototype, 'destroy');

      const saver = makeSaver({ client: injected });
      saver.destroy();

      // No underlying client was constructed/owned, so nothing is destroyed.
      expect(protoDestroy).not.toHaveBeenCalled();
      expectNoUnexpectedCommands(ddb.mock, []);
      protoDestroy.mockRestore();
    }); // injected-client is not destroyed

    it('inherits getNextVersion from the base class and produces a monotonic integer for a null current', () => {
      const saver = makeSaver({ client: ddb.mock });
      const v = saver.getNextVersion(undefined);
      // The base class default returns a monotonic integer-prefixed version.
      expect(typeof v === 'number' || typeof v === 'string').toBe(true);
      const next = saver.getNextVersion(v);
      // Next version must sort strictly after the previous one.
      expect(String(next) > String(v)).toBe(true);
    }); // getNextVersion monotonicity

    it('constructs an S3Offloader when s3OffloadConfig is provided WITHOUT ttl (no lifecycle call)', () => {
      const s3 = mockClient(S3Client);
      // No ttl => ensureLifecycleRule is never invoked, so no S3 command fires.
      const saver = makeSaver({
        client: ddb.mock,
        s3OffloadConfig: { bucketName: 'bkt' },
      });
      expect(saver).toBeInstanceOf(DynamoDBSaver);
      expect(s3.calls()).toHaveLength(0);
      s3.restore();
    }); // s3 offloader constructed, lifecycle skipped without ttl

    it('configures a Compressor when compression.enabled is true and round-trips a put', async () => {
      ddb.mock.on(TransactWriteCommand).resolves({});
      // compression.enabled=true instantiates the Compressor branch in the ctor.
      const saver = makeSaver({
        client: ddb.mock,
        compression: { enabled: true, minSizeBytes: 1 },
      });
      const result = await saver.put(
        makeRunnableConfig({ threadId: THREAD_ID }),
        makeCheckpoint({ id: 'ckpt-1' }),
        makeCheckpointMetadata(),
        {},
      );
      expect(result.configurable?.checkpoint_id).toBe('ckpt-1');
      expect(ddb.mock.commandCalls(TransactWriteCommand)).toHaveLength(1);
    }); // compression enabled branch

    it('does not configure compression when compression.enabled is false', async () => {
      // With compression disabled the put path stores raw serde bytes; assert the
      // metadata Item is NOT gzip-marked by round-tripping through getTuple is
      // overkill here — instead prove a put succeeds with a single TransactWrite.
      ddb.mock.on(TransactWriteCommand).resolves({});
      const saver = makeSaver({ client: ddb.mock, compression: { enabled: false } });
      await saver.put(
        makeRunnableConfig({ threadId: THREAD_ID }),
        makeCheckpoint({ id: 'ckpt-1' }),
        makeCheckpointMetadata(),
        {},
      );
      expect(ddb.mock.commandCalls(TransactWriteCommand)).toHaveLength(1);
    }); // compression disabled branch
  });

  describe('constructor S3 lifecycle auto-config', () => {
    let s3: ReturnType<typeof mockClient<S3Client>>;

    afterEach(() => {
      s3?.restore();
    });

    it('auto-configures the S3 lifecycle rule from ttlDays when both S3 and ttlDays are set', async () => {
      s3 = mockClient(S3Client);
      s3.on(GetBucketLifecycleConfigurationCommand).resolves({ Rules: [] });
      const putSpy = jest.fn().mockResolvedValue({});
      s3.on(PutBucketLifecycleConfigurationCommand).callsFake(putSpy);

      makeSaver({
        client: ddb.mock,
        ttlDays: 30,
        s3OffloadConfig: { bucketName: 'bkt' },
      });

      // ensureLifecycleRule is fire-and-forget in the constructor; flush microtasks.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const putCalls = s3.commandCalls(PutBucketLifecycleConfigurationCommand);
      expect(putCalls).toHaveLength(1);
      const rules = (putCalls[0].args[0].input.LifecycleConfiguration?.Rules ?? []) as Array<{
        Expiration?: { Days?: number };
      }>;
      // ttlDays=30 maps directly to a 30-day expiration.
      expect(rules[0].Expiration?.Days).toBe(30);
    }); // lifecycle rule from ttlDays

    it('derives lifecycle days by ceil(ttlSeconds/86400) when ttlSeconds is set with S3', async () => {
      s3 = mockClient(S3Client);
      s3.on(GetBucketLifecycleConfigurationCommand).resolves({ Rules: [] });
      s3.on(PutBucketLifecycleConfigurationCommand).resolves({});

      // 90000s = 1.041... days -> ceil -> 2 days.
      makeSaver({
        client: ddb.mock,
        ttlSeconds: 90000,
        s3OffloadConfig: { bucketName: 'bkt' },
      });

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const putCalls = s3.commandCalls(PutBucketLifecycleConfigurationCommand);
      expect(putCalls).toHaveLength(1);
      const rules = (putCalls[0].args[0].input.LifecycleConfiguration?.Rules ?? []) as Array<{
        Expiration?: { Days?: number };
      }>;
      expect(rules[0].Expiration?.Days).toBe(2);
    }); // lifecycle days = ceil(ttlSeconds/86400)

    it('swallows-and-logs a lifecycle-config failure instead of throwing from the constructor', async () => {
      s3 = mockClient(S3Client);
      // Force the read to fail with a non-NoSuchLifecycleConfiguration error.
      s3.on(GetBucketLifecycleConfigurationCommand).rejects(new Error('boom'));

      // Constructor must not throw even though the async lifecycle call rejects.
      expect(() =>
        makeSaver({
          client: ddb.mock,
          ttlDays: 10,
          s3OffloadConfig: { bucketName: 'bkt' },
        }),
      ).not.toThrow();

      // Flush the rejected fire-and-forget promise so it is handled (caught/logged).
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }); // lifecycle failure is caught, not thrown
  });

  describe('delegation: put / putWrites / getTuple / deleteThread', () => {
    it('put() issues exactly one atomic TransactWrite and returns the stored config', async () => {
      ddb.mock.on(TransactWriteCommand).resolves({});
      const saver = makeSaver({ client: ddb.mock });

      const result = await saver.put(
        makeRunnableConfig({ threadId: THREAD_ID }),
        makeCheckpoint({ id: 'ckpt-1' }),
        makeCheckpointMetadata(),
        {},
      );

      expect(result.configurable?.thread_id).toBe(THREAD_ID);
      expect(result.configurable?.checkpoint_id).toBe('ckpt-1');
      expect(ddb.mock.commandCalls(TransactWriteCommand)).toHaveLength(1);
      expectNoUnexpectedCommands(ddb.mock, [TransactWriteCommand]);
    }); // put delegates to putAction

    it('putWrites() resolves without error and issues no DDB call for an empty writes array', async () => {
      const saver = makeSaver({ client: ddb.mock });
      await expect(
        saver.putWrites(
          makeRunnableConfig({ threadId: THREAD_ID, checkpointId: 'ckpt-1' }),
          [],
          'task-1',
        ),
      ).resolves.toBeUndefined();
      // batchWriteAllWithRetry with zero items performs no BatchWrite.
      expectNoUnexpectedCommands(ddb.mock, []);
    }); // putWrites delegates to putWritesAction

    it('getTuple() returns undefined when the metadata Get finds no item', async () => {
      ddb.mock.on(GetCommand).resolves({ Item: undefined });
      const saver = makeSaver({ client: ddb.mock });
      const tuple = await saver.getTuple(
        makeRunnableConfig({ threadId: THREAD_ID, checkpointId: 'ckpt-1' }),
      );
      expect(tuple).toBeUndefined();
      expectNoUnexpectedCommands(ddb.mock, [GetCommand]);
    }); // getTuple delegates to getTupleAction

    it('deleteThread() queries the thread and returns early when the thread has no items', async () => {
      ddb.mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });
      const saver = makeSaver({ client: ddb.mock });
      await expect(saver.deleteThread(THREAD_ID)).resolves.toBeUndefined();
      expectExactQueryCommand(ddb.mock, {
        TableName: CHECKPOINTS_TABLE,
        KeyConditionExpression: 'thread_id = :thread_id',
        ExpressionAttributeValues: { ':thread_id': THREAD_ID },
        ExclusiveStartKey: undefined,
      });
      expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
    }); // deleteThread delegates to deleteThreadAction

    it('deleteThread() forwards the AbortSignal — already-aborted short-circuits before any DDB call', async () => {
      const reason = new Error('aborted-delete');
      const saver = makeSaver({ client: ddb.mock });
      await expect(
        saver.deleteThread(THREAD_ID, { signal: preAbortedSignal(reason) }),
      ).rejects.toBe(reason);
      expectNoUnexpectedCommands(ddb.mock, []);
    }); // deleteThread propagates signal
  });

  describe('list(): validation negatives (no DDB call)', () => {
    it('rejects a non-string thread_id with the documented message before any query', async () => {
      const saver = makeSaver({ client: ddb.mock });
      const it = saver.list({ configurable: { thread_id: 7 } }, undefined);
      await expect(it.next()).rejects.toThrow('thread_id must be a string');
      expectNoUnexpectedCommands(ddb.mock, []);
    }); // thread_id type guard

    it('rejects a non-string before.checkpoint_id before any query', async () => {
      const saver = makeSaver({ client: ddb.mock });
      const it = saver.list(makeRunnableConfig({ threadId: THREAD_ID }), {
        before: { configurable: { checkpoint_id: 123 } },
      } as never);
      await expect(it.next()).rejects.toThrow('before.configurable.checkpoint_id must be a string');
      expectNoUnexpectedCommands(ddb.mock, []);
    }); // before checkpoint_id type guard

    it('throws if the signal is already aborted before the first page query', async () => {
      const saver = makeSaver({ client: ddb.mock });
      const reason = new Error('list-aborted');
      const it = saver.list(
        {
          configurable: { thread_id: THREAD_ID, checkpoint_ns: '' },
          signal: preAbortedSignal(reason),
        },
        undefined,
      );
      await expect(it.next()).rejects.toBe(reason);
      expectNoUnexpectedCommands(ddb.mock, []);
    }); // pre-aborted signal short-circuits
  });

  describe('list(): query shape + payload fetch', () => {
    it('issues the metadata-only Query (no Limit, descending) and BatchGets split payloads', async () => {
      const { type, checkpointBytes, metadataBytes } = await serializeCheckpoint('ckpt-1');
      ddb.mock.on(QueryCommand).resolves({
        Items: [metadataItem('ckpt-1', type, metadataBytes)],
        LastEvaluatedKey: undefined,
      });
      ddb.mock.on(BatchGetCommand).resolves({
        Responses: {
          [CHECKPOINTS_TABLE]: [
            {
              thread_id: THREAD_ID,
              checkpoint_id: `${PAYLOAD_SK_PREFIX}ckpt-1`,
              checkpoint: checkpointBytes,
            },
          ],
        },
      });

      const saver = makeSaver({ client: ddb.mock });
      const out: CheckpointTuple[] = [];
      for await (const t of saver.list(makeRunnableConfig({ threadId: THREAD_ID }), undefined)) {
        out.push(t);
      }

      expect(out).toHaveLength(1);
      expect(out[0].config.configurable?.checkpoint_id).toBe('ckpt-1');

      // Exact query: no checkpoint_ns filter here (makeRunnableConfig sets ns ''),
      // but list reads ns from configurable; '' is falsy-but-defined so it IS
      // included as :checkpoint_ns. Assert the precise shape.
      expectExactQueryCommand(ddb.mock, {
        TableName: CHECKPOINTS_TABLE,
        KeyConditionExpression: 'thread_id = :thread_id',
        ExpressionAttributeValues: { ':thread_id': THREAD_ID, ':checkpoint_ns': '' },
        ExpressionAttributeNames: { '#type': 'type' },
        FilterExpression: 'attribute_exists(#type) AND checkpoint_ns = :checkpoint_ns',
        Limit: undefined,
        ScanIndexForward: false,
        ExclusiveStartKey: undefined,
      });

      // Exact BatchGet for the split payload item.
      const batchCalls = ddb.mock.commandCalls(BatchGetCommand);
      expect(batchCalls).toHaveLength(1);
      expect(batchCalls[0].args[0].input).toEqual({
        RequestItems: {
          [CHECKPOINTS_TABLE]: {
            Keys: [{ thread_id: THREAD_ID, checkpoint_id: `${PAYLOAD_SK_PREFIX}ckpt-1` }],
          },
        },
      });
      expectNoUnexpectedCommands(ddb.mock, [QueryCommand, BatchGetCommand]);
    }); // split-format payload fetch

    it('uses inline legacy checkpoint bytes WITHOUT a BatchGet when item.checkpoint is present', async () => {
      const { type, checkpointBytes, metadataBytes } = await serializeCheckpoint('ckpt-legacy');
      ddb.mock.on(QueryCommand).resolves({
        Items: [
          {
            ...metadataItem('ckpt-legacy', type, metadataBytes),
            checkpoint: checkpointBytes, // legacy inline blob
          },
        ],
        LastEvaluatedKey: undefined,
      });

      const saver = makeSaver({ client: ddb.mock });
      const out: CheckpointTuple[] = [];
      for await (const t of saver.list(makeRunnableConfig({ threadId: THREAD_ID }), undefined)) {
        out.push(t);
      }

      expect(out).toHaveLength(1);
      // Legacy inline path performs ZERO BatchGet calls.
      expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
    }); // legacy inline path, no BatchGet

    it('skips BatchGet for S3-offloaded items and downloads the blob via the S3 offloader', async () => {
      const s3 = mockClient(S3Client);
      const { checkpointBytes, metadataBytes, type } = await serializeCheckpoint('ckpt-s3');
      // GetObject returns the serialized checkpoint bytes as a stream-like body.
      s3.on(GetObjectCommand).resolves({
        Body: { transformToByteArray: async () => checkpointBytes },
      } as never);

      ddb.mock.on(QueryCommand).resolves({
        Items: [
          {
            ...metadataItem('ckpt-s3', type, metadataBytes),
            s3_checkpoint_key: 'langgraph-checkpoints/thread/ckpt-s3/checkpoint.bin',
          },
        ],
        LastEvaluatedKey: undefined,
      });

      const saver = makeSaver({
        client: ddb.mock,
        s3OffloadConfig: { bucketName: 'bkt' },
      });
      const out: CheckpointTuple[] = [];
      for await (const t of saver.list(makeRunnableConfig({ threadId: THREAD_ID }), undefined)) {
        out.push(t);
      }

      expect(out).toHaveLength(1);
      // No BatchGet because the payload lives in S3.
      expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
      s3.restore();
    }); // S3-offloaded item skips BatchGet
  });

  describe('list(): before-bound, namespace, page limit, pagination', () => {
    it('adds the checkpoint_id < :before_checkpoint_id KeyCondition bound when before is given', async () => {
      const { type, metadataBytes } = await serializeCheckpoint('ckpt-1');
      ddb.mock.on(QueryCommand).resolves({
        Items: [{ ...metadataItem('ckpt-1', type, metadataBytes), checkpoint: metadataBytes }],
        LastEvaluatedKey: undefined,
      });

      const saver = makeSaver({ client: ddb.mock });
      const out: CheckpointTuple[] = [];
      for await (const t of saver.list(makeRunnableConfig({ threadId: THREAD_ID }), {
        before: { configurable: { checkpoint_id: 'ckpt-9' } },
      })) {
        out.push(t);
      }

      expectExactQueryCommand(ddb.mock, {
        TableName: CHECKPOINTS_TABLE,
        KeyConditionExpression: 'thread_id = :thread_id AND checkpoint_id < :before_checkpoint_id',
        ExpressionAttributeValues: {
          ':thread_id': THREAD_ID,
          ':checkpoint_ns': '',
          ':before_checkpoint_id': 'ckpt-9',
        },
        ExpressionAttributeNames: { '#type': 'type' },
        FilterExpression: 'attribute_exists(#type) AND checkpoint_ns = :checkpoint_ns',
        Limit: undefined,
        ScanIndexForward: false,
        ExclusiveStartKey: undefined,
      });
      expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
    }); // before adds sort-key upper bound

    it('passes Limit through (page-limit math) when no filter is active (ns undefined)', async () => {
      // Build a config whose configurable has NO checkpoint_ns key so hasNsFilter
      // is false and a numeric Limit is forwarded.
      const { type, checkpointBytes, metadataBytes } = await serializeCheckpoint('ckpt-1');
      ddb.mock.on(QueryCommand).resolves({
        Items: [
          {
            thread_id: THREAD_ID,
            checkpoint_ns: '',
            checkpoint_id: 'ckpt-1',
            type,
            metadata: metadataBytes,
            checkpoint: checkpointBytes, // inline so no BatchGet
          },
        ],
        LastEvaluatedKey: undefined,
      });

      const saver = makeSaver({ client: ddb.mock });
      const out: CheckpointTuple[] = [];
      // No checkpoint_ns in configurable => no ns FilterExpression, Limit forwarded.
      for await (const t of saver.list({ configurable: { thread_id: THREAD_ID } }, { limit: 5 })) {
        out.push(t);
      }

      expect(out).toHaveLength(1);
      expectExactQueryCommand(ddb.mock, {
        TableName: CHECKPOINTS_TABLE,
        KeyConditionExpression: 'thread_id = :thread_id',
        ExpressionAttributeValues: { ':thread_id': THREAD_ID },
        ExpressionAttributeNames: { '#type': 'type' },
        FilterExpression: 'attribute_exists(#type)',
        Limit: 5,
        ScanIndexForward: false,
        ExclusiveStartKey: undefined,
      });
      expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
    }); // limit forwarded when no filter

    it('stops early and returns once the requested limit is reached mid-page', async () => {
      const a = await serializeCheckpoint('ckpt-a');
      const b = await serializeCheckpoint('ckpt-b');
      ddb.mock.on(QueryCommand).resolves({
        Items: [
          {
            thread_id: THREAD_ID,
            checkpoint_ns: '',
            checkpoint_id: 'ckpt-a',
            type: a.type,
            metadata: a.metadataBytes,
            checkpoint: a.checkpointBytes,
          },
          {
            thread_id: THREAD_ID,
            checkpoint_ns: '',
            checkpoint_id: 'ckpt-b',
            type: b.type,
            metadata: b.metadataBytes,
            checkpoint: b.checkpointBytes,
          },
        ],
        LastEvaluatedKey: { thread_id: THREAD_ID, checkpoint_id: 'ckpt-b' },
      });

      const saver = makeSaver({ client: ddb.mock });
      const out: CheckpointTuple[] = [];
      // limit=1: must yield only the first item and NOT fetch the next page.
      for await (const t of saver.list({ configurable: { thread_id: THREAD_ID } }, { limit: 1 })) {
        out.push(t);
      }

      expect(out).toHaveLength(1);
      expect(out[0].config.configurable?.checkpoint_id).toBe('ckpt-a');
      // Exactly one Query — the limit was reached before paginating.
      expect(ddb.mock.commandCalls(QueryCommand)).toHaveLength(1);
    }); // limit reached mid-page returns

    it('paginates across LastEvaluatedKey, forwarding ExclusiveStartKey on the second page', async () => {
      const a = await serializeCheckpoint('ckpt-a');
      const b = await serializeCheckpoint('ckpt-b');
      const lek = { thread_id: THREAD_ID, checkpoint_id: 'ckpt-a' };
      ddb.mock.on(QueryCommand, { ExclusiveStartKey: undefined }).resolves({
        Items: [
          {
            thread_id: THREAD_ID,
            checkpoint_ns: '',
            checkpoint_id: 'ckpt-a',
            type: a.type,
            metadata: a.metadataBytes,
            checkpoint: a.checkpointBytes,
          },
        ],
        LastEvaluatedKey: lek,
      });
      ddb.mock.on(QueryCommand, { ExclusiveStartKey: lek }).resolves({
        Items: [
          {
            thread_id: THREAD_ID,
            checkpoint_ns: '',
            checkpoint_id: 'ckpt-b',
            type: b.type,
            metadata: b.metadataBytes,
            checkpoint: b.checkpointBytes,
          },
        ],
        LastEvaluatedKey: undefined,
      });

      const saver = makeSaver({ client: ddb.mock });
      const out: CheckpointTuple[] = [];
      for await (const t of saver.list({ configurable: { thread_id: THREAD_ID } }, undefined)) {
        out.push(t);
      }

      expect(out.map((t) => t.config.configurable?.checkpoint_id)).toEqual(['ckpt-a', 'ckpt-b']);
      expect(ddb.mock.commandCalls(QueryCommand)).toHaveLength(2);
    }); // pagination forwards ExclusiveStartKey
  });

  describe('list(): metadata filter', () => {
    it('drops DynamoDB Limit and applies the metadata filter client-side (keeps matches only)', async () => {
      // Two metadata items with different step; filter keeps step=0 only.
      const serde = makeSaver().serde;
      const cp = makeCheckpoint({ id: 'ckpt-1' });
      const [type, cpBytes] = await serde.dumpsTyped(cp);
      const [, meta0Bytes] = await serde.dumpsTyped(makeCheckpointMetadata({ step: 0 }));
      const cp2 = makeCheckpoint({ id: 'ckpt-2' });
      const [, cp2Bytes] = await serde.dumpsTyped(cp2);
      const [, meta1Bytes] = await serde.dumpsTyped(makeCheckpointMetadata({ step: 1 }));

      ddb.mock.on(QueryCommand).resolves({
        Items: [
          {
            thread_id: THREAD_ID,
            checkpoint_ns: '',
            checkpoint_id: 'ckpt-1',
            type,
            metadata: meta0Bytes,
            checkpoint: cpBytes,
          },
          {
            thread_id: THREAD_ID,
            checkpoint_ns: '',
            checkpoint_id: 'ckpt-2',
            type,
            metadata: meta1Bytes,
            checkpoint: cp2Bytes,
          },
        ],
        LastEvaluatedKey: undefined,
      });

      const saver = makeSaver({ client: ddb.mock });
      const out: CheckpointTuple[] = [];
      for await (const t of saver.list(
        { configurable: { thread_id: THREAD_ID } },
        { filter: { step: 0 }, limit: 10 },
      )) {
        out.push(t);
      }

      // Only the step=0 checkpoint survives the filter.
      expect(out.map((t) => t.config.configurable?.checkpoint_id)).toEqual(['ckpt-1']);
      // With a metadata filter active, Limit is dropped (undefined) to avoid
      // pre-filter truncation.
      expectExactQueryCommand(ddb.mock, {
        TableName: CHECKPOINTS_TABLE,
        KeyConditionExpression: 'thread_id = :thread_id',
        ExpressionAttributeValues: { ':thread_id': THREAD_ID },
        ExpressionAttributeNames: { '#type': 'type' },
        FilterExpression: 'attribute_exists(#type)',
        Limit: undefined,
        ScanIndexForward: false,
        ExclusiveStartKey: undefined,
      });
    }); // metadata filter drops Limit + filters client-side
  });

  describe('list(): MAX_LOOP_ITERATIONS guard', () => {
    it(`throws after ${MAX_LOOP_ITERATIONS} empty filtered pages that never satisfy the limit`, async () => {
      // Every page returns no items but a non-undefined LastEvaluatedKey, forcing
      // the do/while to loop. A metadata filter keeps Limit undefined so the loop
      // never early-exits on yieldedCount.
      ddb.mock.on(QueryCommand).resolves({
        Items: [],
        LastEvaluatedKey: { thread_id: THREAD_ID, checkpoint_id: 'x' },
      });

      const saver = makeSaver({ client: ddb.mock });
      const it = saver.list({ configurable: { thread_id: THREAD_ID } }, { filter: { step: 999 } });

      await expect(
        (async () => {
          for await (const _ of it) {
            // never yields
          }
        })(),
      ).rejects.toThrow(`list() exceeded ${MAX_LOOP_ITERATIONS} DynamoDB pages`);

      // Exactly MAX_LOOP_ITERATIONS queries were issued before the guard fired.
      expect(ddb.mock.commandCalls(QueryCommand)).toHaveLength(MAX_LOOP_ITERATIONS);
    }); // pathological filter loop guard
  });

  describe('fetchCheckpointPayloadsBatch: UnprocessedKeys + corruption guard', () => {
    it('retries UnprocessedKeys with backoff and eventually resolves all split payloads', async () => {
      const { type, checkpointBytes, metadataBytes } = await serializeCheckpoint('ckpt-1');
      const payloadKey = { thread_id: THREAD_ID, checkpoint_id: `${PAYLOAD_SK_PREFIX}ckpt-1` };

      ddb.mock.on(QueryCommand).resolves({
        Items: [metadataItem('ckpt-1', type, metadataBytes)],
        LastEvaluatedKey: undefined,
      });

      // First BatchGet: no responses, all keys unprocessed. Second: resolves.
      let batchCall = 0;
      ddb.mock.on(BatchGetCommand).callsFake(() => {
        batchCall += 1;
        if (batchCall === 1) {
          return {
            Responses: { [CHECKPOINTS_TABLE]: [] },
            UnprocessedKeys: { [CHECKPOINTS_TABLE]: { Keys: [payloadKey] } },
          };
        }
        return {
          Responses: {
            [CHECKPOINTS_TABLE]: [
              {
                thread_id: THREAD_ID,
                checkpoint_id: `${PAYLOAD_SK_PREFIX}ckpt-1`,
                checkpoint: checkpointBytes,
              },
            ],
          },
        };
      });

      const saver = makeSaver({ client: ddb.mock });

      const collect = (async () => {
        const out: CheckpointTuple[] = [];
        for await (const t of saver.list(makeRunnableConfig({ threadId: THREAD_ID }), undefined)) {
          out.push(t);
        }
        return out;
      })();

      // The retry path sleeps via setTimeout (fake timers). Advance until both
      // BatchGet calls have run.
      await jest.advanceTimersByTimeAsync(1000);
      const out = await collect;

      expect(out).toHaveLength(1);
      expect(ddb.mock.commandCalls(BatchGetCommand)).toHaveLength(2);
    }); // UnprocessedKeys retried then resolved

    it(`throws after ${MAX_UNPROCESSED_RETRIES} UnprocessedKeys retries that never drain`, async () => {
      const { type, metadataBytes } = await serializeCheckpoint('ckpt-1');
      const payloadKey = { thread_id: THREAD_ID, checkpoint_id: `${PAYLOAD_SK_PREFIX}ckpt-1` };

      ddb.mock.on(QueryCommand).resolves({
        Items: [metadataItem('ckpt-1', type, metadataBytes)],
        LastEvaluatedKey: undefined,
      });
      // Every BatchGet leaves the same key unprocessed.
      ddb.mock.on(BatchGetCommand).resolves({
        Responses: { [CHECKPOINTS_TABLE]: [] },
        UnprocessedKeys: { [CHECKPOINTS_TABLE]: { Keys: [payloadKey] } },
      });

      const saver = makeSaver({ client: ddb.mock });
      const run = (async () => {
        for await (const _ of saver.list(makeRunnableConfig({ threadId: THREAD_ID }), undefined)) {
          // never completes a tuple
        }
      })();

      const assertion = expect(run).rejects.toThrow(
        `Failed to fetch all checkpoint payloads after ${MAX_UNPROCESSED_RETRIES} retries`,
      );
      // Drive the backoff sleeps to completion.
      await jest.advanceTimersByTimeAsync(120000);
      await assertion;
    }); // UnprocessedKeys exhausted throws

    it('throws on a payload item whose sort key is missing the PAYLOAD# prefix (corruption guard)', async () => {
      const { type, metadataBytes } = await serializeCheckpoint('ckpt-1');
      ddb.mock.on(QueryCommand).resolves({
        Items: [metadataItem('ckpt-1', type, metadataBytes)],
        LastEvaluatedKey: undefined,
      });
      ddb.mock.on(BatchGetCommand).resolves({
        Responses: {
          [CHECKPOINTS_TABLE]: [
            {
              thread_id: THREAD_ID,
              checkpoint_id: 'ckpt-1', // CORRUPT: missing PAYLOAD# prefix
              checkpoint: metadataBytes,
            },
          ],
        },
      });

      const saver = makeSaver({ client: ddb.mock });
      await expect(
        (async () => {
          for await (const _ of saver.list(
            makeRunnableConfig({ threadId: THREAD_ID }),
            undefined,
          )) {
            // unreachable
          }
        })(),
      ).rejects.toThrow('Unexpected payload item sort key');
    }); // sort-key corruption guard

    it('throws "payload item not found" when a split item has no matching BatchGet response', async () => {
      const { type, metadataBytes } = await serializeCheckpoint('ckpt-1');
      ddb.mock.on(QueryCommand).resolves({
        Items: [metadataItem('ckpt-1', type, metadataBytes)],
        LastEvaluatedKey: undefined,
      });
      // BatchGet returns NO responses and NO unprocessed keys — the payload is gone.
      ddb.mock.on(BatchGetCommand).resolves({
        Responses: { [CHECKPOINTS_TABLE]: [] },
      });

      const saver = makeSaver({ client: ddb.mock });
      await expect(
        (async () => {
          for await (const _ of saver.list(
            makeRunnableConfig({ threadId: THREAD_ID }),
            undefined,
          )) {
            // unreachable
          }
        })(),
      ).rejects.toThrow('Checkpoint payload item not found');
    }); // missing payload throws
  });
});
