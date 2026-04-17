/**
 * End-to-end DynamoDBSaver + S3 offloading tests against DynamoDB Local + LocalStack.
 *
 * The saver's S3 path is the riskiest single slice of the library: it crosses
 * *two* external services, mixes compression with offloading, and has a
 * best-effort orphan cleanup on DDB transactWrite failure. These tests exercise
 * every interaction against real AWS APIs:
 *
 *   1. Threshold-sized payload forces offload — state reconstructs identically
 *   2. Compression + offload together — we never write uncompressed blobs to S3
 *   3. putWrites with large values offloads writes into per-write S3 keys
 *   4. deleteThread removes S3 objects alongside DDB items
 *   5. Orphan cleanup: DDB transactWrite failure leaves zero S3 orphans
 */

import { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { DynamoDBSaver } from '../../src/checkpointer';
import {
  assertDdbLocalReachable,
  createAllTables,
  dropAllTables,
  makeLocalClient,
  uniquePrefix,
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

const prefix = uniquePrefix('saver-s3');
const bucketName = uniqueBucketName('saver-s3');
const { ddb, doc } = makeLocalClient();
const probeS3 = makeLocalStackS3Client();

// Small threshold so a modest payload trips offload without needing multi-MB test data.
const OFFLOAD_THRESHOLD = 2 * 1024;

/**
 * Build a low-compressibility payload of the requested size. Deterministic
 * (seedless LCG) so test re-runs produce identical data, but high-entropy
 * enough that gzip can't squeeze it below the offload threshold. Using
 * repetitive content like `"xy".repeat(n)` compresses to a few hundred bytes
 * and silently disables the offload path we're trying to exercise.
 */
function randomLikePayload(label: string, bytes: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let state = 0x1234_5678;
  const parts: string[] = [`${label}:`];
  for (let i = 0; i < bytes; i++) {
    // xorshift32 — spreads bytes across the charset so gzip can't find a repeating pattern.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    parts.push(chars[Math.abs(state) % chars.length]);
  }
  return parts.join('');
}

let tables: Awaited<ReturnType<typeof createAllTables>>;
let saver: DynamoDBSaver;

beforeAll(async () => {
  await assertDdbLocalReachable(ddb);
  await assertLocalStackReachable(probeS3);
  tables = await createAllTables(ddb, prefix);
  await createBucket(probeS3, bucketName);

  saver = new DynamoDBSaver({
    checkpointsTableName: tables.checkpointsTable,
    writesTableName: tables.writesTable,
    client: doc,
    compression: { enabled: true, minSizeBytes: 256 },
    s3OffloadConfig: {
      bucketName,
      keyPrefix: 'langgraph-it/',
      thresholdBytes: OFFLOAD_THRESHOLD,
      clientConfig: LOCALSTACK_S3_CONFIG,
    },
  });
});

afterAll(async () => {
  saver.destroy();
  await dropAllTables(ddb, tables);
  await dropBucket(probeS3, bucketName);
  ddb.destroy();
  probeS3.destroy();
});

function bigPayload(label: string, bytes: number): string {
  return randomLikePayload(label, bytes);
}

function mkCheckpoint(id: string, payload: string): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date().toISOString(),
    channel_values: { data: payload },
    channel_versions: { data: 1 },
    versions_seen: {},
  };
}

function mkMetadata(extra?: Record<string, unknown>): CheckpointMetadata {
  return { source: 'input', step: 0, parents: {}, ...(extra ?? {}) } as CheckpointMetadata;
}

describe('DynamoDBSaver + S3 offload against LocalStack', () => {
  it('round-trips a large checkpoint through S3 and decompresses on read', async () => {
    const config = { configurable: { thread_id: 'thread-s3-basic' } };
    const payload = bigPayload('basic', OFFLOAD_THRESHOLD * 4);
    const checkpoint = mkCheckpoint('ckpt-big', payload);

    await saver.put(config, checkpoint, mkMetadata(), {});

    // The offloaded checkpoint blob landed in S3 under the configured prefix —
    // proving the saver actually chose the S3 path, not inline DDB storage.
    const s3Count = await countObjects(probeS3, bucketName, 'langgraph-it/thread-s3-basic/');
    expect(s3Count).toBeGreaterThanOrEqual(1);

    const tuple = await saver.getTuple({
      configurable: { thread_id: 'thread-s3-basic', checkpoint_id: 'ckpt-big' },
    });

    // Full state survives the compress → S3 → DDB → S3 → decompress round-trip.
    expect(tuple).toBeDefined();
    expect((tuple!.checkpoint.channel_values as { data: string }).data).toBe(payload);
  });

  it('small checkpoints stay inline — no S3 objects are written', async () => {
    const config = { configurable: { thread_id: 'thread-small' } };
    // Below both compression threshold (256) and offload threshold (2048).
    await saver.put(config, mkCheckpoint('ckpt-tiny', 'hi'), mkMetadata(), {});

    const count = await countObjects(probeS3, bucketName, 'langgraph-it/thread-small/');
    expect(count).toBe(0);
  });

  it('putWrites offloads oversized write values into per-write S3 keys', async () => {
    const threadId = 'thread-writes-s3';
    await saver.put(
      { configurable: { thread_id: threadId } },
      mkCheckpoint('ckpt-w', 'x'),
      mkMetadata(),
      {},
    );

    const big = bigPayload('w', OFFLOAD_THRESHOLD * 3);
    await saver.putWrites(
      { configurable: { thread_id: threadId, checkpoint_id: 'ckpt-w', checkpoint_ns: '' } },
      [['channel-a', { blob: big }]],
      'task-big',
    );

    // Each write's S3 key lives under the checkpoint folder with `write-<idx>` suffix.
    const count = await countObjects(probeS3, bucketName, `langgraph-it/${threadId}/ckpt-w/`);
    expect(count).toBeGreaterThanOrEqual(1);

    const tuple = await saver.getTuple({
      configurable: { thread_id: threadId, checkpoint_id: 'ckpt-w', checkpoint_ns: '' },
    });
    expect(tuple?.pendingWrites).toHaveLength(1);
    const [, , value] = tuple!.pendingWrites![0];
    expect((value as { blob: string }).blob).toBe(big);
  });

  it('deleteThread removes every offloaded S3 object for the thread', async () => {
    const threadId = 'thread-delete-s3';
    const config = { configurable: { thread_id: threadId } };
    const big = bigPayload('del', OFFLOAD_THRESHOLD * 3);
    await saver.put(config, mkCheckpoint('d1', big), mkMetadata(), {});
    await saver.put(config, mkCheckpoint('d2', big), mkMetadata(), {});
    await saver.putWrites(
      { configurable: { thread_id: threadId, checkpoint_id: 'd2', checkpoint_ns: '' } },
      [['chan', { blob: big }]],
      'task-del',
    );

    const before = await countObjects(probeS3, bucketName, `langgraph-it/${threadId}/`);
    expect(before).toBeGreaterThanOrEqual(3);

    await saver.deleteThread(threadId);

    const after = await countObjects(probeS3, bucketName, `langgraph-it/${threadId}/`);
    expect(after).toBe(0);
  });

  it('preserves canonical S3 data on a ConditionalCheckFailed conflict', async () => {
    // Two divergent writers racing on the same (thread_id, checkpoint_id)
    // produce IDENTICAL S3 keys — they're derived deterministically from
    // (thread_id, checkpoint_id). If we blindly clean up keys on a transact
    // failure, we'd delete the canonical data the winning writer still
    // references. The saver must therefore SKIP orphan cleanup on
    // ConditionalCheckFailed / TransactionCanceledException — lifecycle-rule
    // sweep handles any residual staleness.
    const threadId = 'thread-orphan';
    const big = bigPayload('orphan', OFFLOAD_THRESHOLD * 3);

    // First (winning) put: canonical state lands in S3.
    await saver.put(
      { configurable: { thread_id: threadId, checkpoint_id: 'p1' } },
      mkCheckpoint('child', big),
      mkMetadata(),
      {},
    );
    const beforeSecond = await countObjects(probeS3, bucketName, `langgraph-it/${threadId}/`);
    expect(beforeSecond).toBeGreaterThanOrEqual(1);

    // Second (losing) put: same checkpoint_id, different parent — optimistic
    // lock fires, transactWrite rejects with TransactionCanceledException.
    await expect(
      saver.put(
        { configurable: { thread_id: threadId, checkpoint_id: 'p2' } },
        mkCheckpoint('child', big),
        mkMetadata({ step: 99 }),
        {},
      ),
    ).rejects.toMatchObject({ name: 'TransactionCanceledException' });

    // Canonical data still readable — prove the cleanup did NOT delete it.
    const tuple = await saver.getTuple({
      configurable: { thread_id: threadId, checkpoint_id: 'child' },
    });
    expect(tuple).toBeDefined();
    expect((tuple!.checkpoint.channel_values as { data: string }).data).toBe(big);
    // parent lineage still points at p1 (the winning write).
    expect(tuple!.parentConfig?.configurable?.checkpoint_id).toBe('p1');
  });

  it('cleans up S3 orphans when the DDB write fails for a non-conflict reason', async () => {
    // Point a fresh saver at a non-existent writes table — `put()` itself only
    // touches the checkpoints table, but we need a way to force a
    // non-CCFE failure AFTER the S3 upload completes. Using a bogus
    // checkpoints table name forces DDB to reject the transact with
    // ResourceNotFoundException, which IS eligible for orphan cleanup.
    const orphanBucket = uniqueBucketName('orphan-cleanup');
    await createBucket(probeS3, orphanBucket);

    const failingSaver = new DynamoDBSaver({
      checkpointsTableName: 'does-not-exist-table',
      writesTableName: tables.writesTable,
      client: doc,
      s3OffloadConfig: {
        bucketName: orphanBucket,
        keyPrefix: 'orphan-it/',
        thresholdBytes: OFFLOAD_THRESHOLD,
        clientConfig: LOCALSTACK_S3_CONFIG,
      },
    });

    try {
      const big = bigPayload('orphan-clean', OFFLOAD_THRESHOLD * 3);
      await expect(
        failingSaver.put(
          { configurable: { thread_id: 'thread-orphan-clean' } },
          mkCheckpoint('ckpt-orphan', big),
          mkMetadata(),
          {},
        ),
      ).rejects.toMatchObject({ name: 'ResourceNotFoundException' });

      // cleanUpS3Orphans runs on non-conflict failures; S3 keys the failed put
      // uploaded are deleted. Bucket is empty.
      const remaining = await countObjects(probeS3, orphanBucket, 'orphan-it/');
      expect(remaining).toBe(0);
    } finally {
      failingSaver.destroy();
      await dropBucket(probeS3, orphanBucket);
    }
  });

  it('ensureLifecycleRule is applied when the saver is configured with ttlDays', async () => {
    // The saver fires ensureLifecycleRule once at construction when both S3
    // offload and TTL are configured. Build a fresh bucket + saver so we can
    // observe the rule from a clean starting state.
    const freshBucket = uniqueBucketName('saver-lifecycle');
    await createBucket(probeS3, freshBucket);
    const freshTables = await createAllTables(ddb, `${prefix}-lc`);

    const lcSaver = new DynamoDBSaver({
      checkpointsTableName: freshTables.checkpointsTable,
      writesTableName: freshTables.writesTable,
      client: doc,
      ttlDays: 14,
      s3OffloadConfig: {
        bucketName: freshBucket,
        keyPrefix: 'lc-it/',
        thresholdBytes: OFFLOAD_THRESHOLD,
        clientConfig: LOCALSTACK_S3_CONFIG,
      },
    });

    try {
      // ensureLifecycleRule is fire-and-forget in the constructor. Poll briefly.
      const { GetBucketLifecycleConfigurationCommand } = await import('@aws-sdk/client-s3');
      for (let i = 0; i < 30; i++) {
        try {
          const cfg = await probeS3.send(
            new GetBucketLifecycleConfigurationCommand({ Bucket: freshBucket }),
          );
          const rule = cfg.Rules?.find((r) => r.ID === 'langgraph-ttl-lc-it');
          if (rule?.Expiration?.Days === 14) {
            expect(rule.Status).toBe('Enabled');
            expect((rule.Filter as { Prefix?: string } | undefined)?.Prefix).toBe('lc-it/');
            return;
          }
        } catch {
          /* NoSuchLifecycleConfiguration before the background write completes */
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error('Expected lifecycle rule langgraph-ttl-lc-it with 14-day expiration');
    } finally {
      lcSaver.destroy();
      await dropAllTables(ddb, freshTables);
      await dropBucket(probeS3, freshBucket);
    }
  });
});
