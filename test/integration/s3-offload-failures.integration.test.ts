import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import type { RunnableConfig } from '@langchain/core/runnables';
/**
 * Integration: S3 offload FAILURE paths against REAL LocalStack S3 + DDB Local
 * (REQ-34 / gap F / AC-30).
 *
 * Real services — NO aws-sdk-client-mock, NO jest.mock. Failures are induced
 * with real S3 conditions LocalStack actually produces:
 *   - PutObject against a non-existent bucket -> the offload write fails mid-put,
 *     and the library must not persist a half-written DDB pointer (no checkpoint
 *     row visible to a subsequent reader).
 *   - A live DDB pointer whose S3 object has been deleted (404 GetObject) ->
 *     getTuple surfaces the documented dangling-reference error rather than
 *     silently returning a corrupt tuple.
 *
 * Env-gated via RUN_INTEGRATION (REQ-30 / AC-26).
 */
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { DynamoDBSaver } from '../../src/index';
import {
  assertDdbLocalReachable,
  createAllTables,
  dropAllTables,
  makeLocalClient,
  uniquePrefix,
  DDB_LOCAL_ENDPOINT,
} from './helpers/ddb-local';
import {
  assertLocalStackReachable,
  createBucket,
  dropBucket,
  LOCALSTACK_S3_CONFIG,
  makeLocalStackS3Client,
  uniqueBucketName,
} from './helpers/localstack';

const RUN = !!process.env.RUN_INTEGRATION;
const describeIntegration = RUN ? describe : describe.skip;
const THRESHOLD_BYTES = 4 * 1024;

function makeCheckpoint(id: string, payloadBytes: number): Checkpoint {
  return {
    v: 1,
    id,
    ts: '2023-11-14T22:13:20.000Z',
    channel_values: { messages: 'y'.repeat(payloadBytes) },
    channel_versions: {},
    versions_seen: {},
    pending_sends: [],
  } as unknown as Checkpoint;
}

function makeMetadata(): CheckpointMetadata {
  return { source: 'input', step: 0, parents: {} } as CheckpointMetadata;
}

function ddbClientConfig(): {
  endpoint: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
} {
  return {
    endpoint: DDB_LOCAL_ENDPOINT,
    region: 'local',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  };
}

describeIntegration('integration: S3 offload failure handling', () => {
  const prefix = uniquePrefix('s3-fail');
  let ddb: DynamoDBClient;
  let s3: S3Client;
  let tables: { checkpointsTable: string; writesTable: string };

  beforeAll(async () => {
    const local = makeLocalClient();
    ddb = local.ddb;
    s3 = makeLocalStackS3Client();
    await assertDdbLocalReachable(ddb);
    await assertLocalStackReachable(s3);
    tables = await createAllTables(ddb, prefix);
  });

  afterAll(async () => {
    if (RUN) await dropAllTables(ddb, tables);
  });

  it('leaves no readable checkpoint pointer when the mid-write S3 PutObject fails (offload bucket does not exist)', async () => {
    // Point the offloader at a bucket that was never created: the real
    // PutObject raises NoSuchBucket, failing the write before any pointer
    // can be committed.
    const missingBucket = uniqueBucketName('s3-fail-missing');
    const saver = new DynamoDBSaver({
      checkpointsTableName: tables.checkpointsTable,
      writesTableName: tables.writesTable,
      clientConfig: ddbClientConfig(),
      s3OffloadConfig: {
        bucketName: missingBucket,
        thresholdBytes: THRESHOLD_BYTES,
        clientConfig: LOCALSTACK_S3_CONFIG,
      },
    });
    try {
      const threadId = `${prefix}-midwrite`;
      const config: RunnableConfig = {
        configurable: { thread_id: threadId, checkpoint_ns: '' },
      };
      const checkpoint = makeCheckpoint('ckpt-midwrite', THRESHOLD_BYTES * 4);

      await expect(saver.put(config, checkpoint, makeMetadata(), {})).rejects.toThrow();

      // No half-written pointer: a fresh reader sees no tuple for this thread.
      const reader = new DynamoDBSaver({
        checkpointsTableName: tables.checkpointsTable,
        writesTableName: tables.writesTable,
        clientConfig: ddbClientConfig(),
      });
      try {
        const tuple = await reader.getTuple({
          configurable: { thread_id: threadId, checkpoint_ns: '' },
        });
        expect(tuple).toBeUndefined();
      } finally {
        reader.destroy();
      }
    } finally {
      saver.destroy();
    }
  }); // AC-30

  it('surfaces the documented dangling-reference error when a live DDB pointer points at a deleted S3 object (404)', async () => {
    const bucket = uniqueBucketName('s3-fail-404');
    await createBucket(s3, bucket);
    const saver = new DynamoDBSaver({
      checkpointsTableName: tables.checkpointsTable,
      writesTableName: tables.writesTable,
      clientConfig: ddbClientConfig(),
      s3OffloadConfig: {
        bucketName: bucket,
        thresholdBytes: THRESHOLD_BYTES,
        clientConfig: LOCALSTACK_S3_CONFIG,
      },
    });
    try {
      const threadId = `${prefix}-dangling`;
      const config: RunnableConfig = {
        configurable: { thread_id: threadId, checkpoint_ns: '' },
      };
      const checkpoint = makeCheckpoint('ckpt-dangling', THRESHOLD_BYTES * 4);
      const nextConfig = await saver.put(config, checkpoint, makeMetadata(), {});

      // Confirm an S3 object was written, then delete it out from under the
      // still-live DDB pointer to create a dangling reference.
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
      const keys = (listed.Contents ?? []).map((c) => ({ Key: c.Key! })).filter((k) => k.Key);
      expect(keys.length).toBeGreaterThan(0);
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys, Quiet: true },
        }),
      );

      const readConfig: RunnableConfig = {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: '',
          checkpoint_id: nextConfig.configurable?.checkpoint_id as string,
        },
      };
      // The DDB pointer is intact but the S3 object is gone: read must throw,
      // not return a corrupt/empty tuple.
      await expect(saver.getTuple(readConfig)).rejects.toThrow();
    } finally {
      saver.destroy();
      if (RUN) await dropBucket(s3, bucket);
    }
  }); // AC-30
});
