import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { S3Client } from '@aws-sdk/client-s3';
import type { RunnableConfig } from '@langchain/core/runnables';
/**
 * Integration: checkpoint S3 offload round-trip against REAL LocalStack S3 +
 * DDB Local (REQ-34 / gap F / AC-30).
 *
 * These tests hit real services — NO aws-sdk-client-mock, NO jest.mock, NO
 * createS3Client seam. The S3 client is built by the library from the real
 * s3OffloadConfig.clientConfig pointed at LocalStack; DynamoDB is DDB Local.
 *
 * Env-gated: the whole file skips cleanly unless RUN_INTEGRATION is set, so the
 * unit-only `npm test` path stays green without docker (REQ-30 / AC-26). When
 * enabled it reaches the endpoints exported by the existing helpers
 * (LOCALSTACK_ENDPOINT defaults to http://localhost:4566; DDB_LOCAL_ENDPOINT to
 * http://localhost:8000).
 *
 * Happy path: a checkpoint payload that exceeds the offload threshold is
 * written to real S3 and rehydrated verbatim on read (getTuple round-trip).
 * Negative path: a small payload below the threshold is NOT offloaded (zero S3
 * objects) and is still read back inline.
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
  countObjects,
  createBucket,
  dropBucket,
  LOCALSTACK_S3_CONFIG,
  makeLocalStackS3Client,
  uniqueBucketName,
} from './helpers/localstack';

const RUN = !!process.env.RUN_INTEGRATION;
const describeIntegration = RUN ? describe : describe.skip;

/** A checkpoint whose channel payload size we control precisely. */
function makeCheckpoint(id: string, payloadBytes: number): Checkpoint {
  return {
    v: 1,
    id,
    ts: '2023-11-14T22:13:20.000Z',
    channel_values: { messages: 'x'.repeat(payloadBytes) },
    channel_versions: {},
    versions_seen: {},
    pending_sends: [],
  } as unknown as Checkpoint;
}

function makeMetadata(): CheckpointMetadata {
  return { source: 'input', step: 0, parents: {} } as CheckpointMetadata;
}

describeIntegration('integration: checkpointer S3 offload round-trip', () => {
  const prefix = uniquePrefix('ckpt-s3');
  const bucket = uniqueBucketName('ckpt-s3');
  // Small threshold so a modest payload crosses the offload boundary.
  const THRESHOLD_BYTES = 4 * 1024;

  let ddb: DynamoDBClient;
  let s3: S3Client;
  let tables: { checkpointsTable: string; writesTable: string };
  let saver: DynamoDBSaver;

  beforeAll(async () => {
    const local = makeLocalClient();
    ddb = local.ddb;
    s3 = makeLocalStackS3Client();
    await assertDdbLocalReachable(ddb);
    await assertLocalStackReachable(s3);
    await createBucket(s3, bucket);
    tables = await createAllTables(ddb, prefix);
    saver = new DynamoDBSaver({
      checkpointsTableName: tables.checkpointsTable,
      writesTableName: tables.writesTable,
      clientConfig: {
        endpoint: DDB_LOCAL_ENDPOINT,
        region: 'local',
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      },
      s3OffloadConfig: {
        bucketName: bucket,
        thresholdBytes: THRESHOLD_BYTES,
        clientConfig: LOCALSTACK_S3_CONFIG,
      },
    });
  });

  afterAll(async () => {
    saver?.destroy();
    if (RUN) {
      await dropBucket(s3, bucket);
      await dropAllTables(ddb, tables);
    }
  });

  it('offloads a checkpoint exceeding the threshold to real S3 and rehydrates the exact channel payload on read', async () => {
    const threadId = `${prefix}-large`;
    const config: RunnableConfig = {
      configurable: { thread_id: threadId, checkpoint_ns: '' },
    };
    const bigPayload = THRESHOLD_BYTES * 4;
    const checkpoint = makeCheckpoint('ckpt-large', bigPayload);

    const before = await countObjects(s3, bucket);
    const nextConfig = await saver.put(config, checkpoint, makeMetadata(), {});
    const after = countObjects(s3, bucket);

    // The large payload produced at least one real S3 object.
    expect(await after).toBeGreaterThan(before);

    const readConfig: RunnableConfig = {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: '',
        checkpoint_id: nextConfig.configurable?.checkpoint_id as string,
      },
    };
    const tuple = await saver.getTuple(readConfig);

    expect(tuple).not.toBeUndefined();
    expect(tuple?.checkpoint.id).toBe('ckpt-large');
    // Round-trip: the rehydrated channel value equals what was written.
    expect((tuple?.checkpoint.channel_values as { messages: string }).messages).toBe(
      'x'.repeat(bigPayload),
    );
  }); // AC-30

  it('does NOT offload a checkpoint below the threshold (zero S3 objects) yet still reads it back inline', async () => {
    const smallPrefix = uniqueBucketName('ckpt-s3-small');
    await createBucket(s3, smallPrefix);
    const smallSaver = new DynamoDBSaver({
      checkpointsTableName: tables.checkpointsTable,
      writesTableName: tables.writesTable,
      clientConfig: {
        endpoint: DDB_LOCAL_ENDPOINT,
        region: 'local',
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      },
      s3OffloadConfig: {
        bucketName: smallPrefix,
        thresholdBytes: THRESHOLD_BYTES,
        clientConfig: LOCALSTACK_S3_CONFIG,
      },
    });
    try {
      const threadId = `${prefix}-small`;
      const config: RunnableConfig = {
        configurable: { thread_id: threadId, checkpoint_ns: '' },
      };
      const checkpoint = makeCheckpoint('ckpt-small', 16);

      const nextConfig = await smallSaver.put(config, checkpoint, makeMetadata(), {});

      // Nothing crossed the threshold: the offload bucket stays empty.
      expect(await countObjects(s3, smallPrefix)).toBe(0);

      const tuple = await smallSaver.getTuple({
        configurable: {
          thread_id: threadId,
          checkpoint_ns: '',
          checkpoint_id: nextConfig.configurable?.checkpoint_id as string,
        },
      });
      expect(tuple?.checkpoint.id).toBe('ckpt-small');
      expect((tuple?.checkpoint.channel_values as { messages: string }).messages).toBe(
        'x'.repeat(16),
      );
    } finally {
      smallSaver.destroy();
      if (RUN) await dropBucket(s3, smallPrefix);
    }
  }); // AC-30
});
