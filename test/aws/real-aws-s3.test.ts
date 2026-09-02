import { randomBytes, randomUUID } from 'node:crypto';

import { CreateTableCommand, DynamoDBClient, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import {
  CreateBucketCommand,
  ListObjectsV2Command,
  S3Client,
  waitUntilBucketExists,
} from '@aws-sdk/client-s3';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import type { Checkpoint } from '@langchain/langgraph-checkpoint';

import { DynamoDBSaver, DynamoDBStore } from '../../src/index';
import { DEFAULT_RETRY_MAX_ATTEMPTS } from '../../src/shared/constants';
import { dropResponses, installFaults } from '../integration/helpers/fault-injection';
import { deleteBucketCompletely, deleteTableCompletely, settleAll } from './helpers/teardown';

const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
const clientConfig = region ? { region } : {};
const suffix = randomUUID();
const tableName = `aws-langgraph-s3test-${suffix}`;
const bucketName = `aws-langgraph-s3test-${suffix}`;
const KEY_PREFIX = 'langgraph-checkpoints/';

/**
 * ~683 KB of incompressible data. It clears both the 350 KB offload threshold
 * and DynamoDB's 400 KB item cap, so a write can only succeed if the bytes truly
 * land in S3 — gzip cannot shrink random data back under the threshold.
 */
const bigPayload = randomBytes(512 * 1024).toString('base64');

function bigCheckpoint(id: string): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date(0).toISOString(),
    channel_values: { blob: bigPayload },
    channel_versions: { blob: 1 },
    versions_seen: {},
  };
}

async function offloadedObjectCount(s3: S3Client): Promise<number> {
  const listed = await s3.send(
    new ListObjectsV2Command({ Bucket: bucketName, Prefix: KEY_PREFIX }),
  );
  return listed.KeyCount ?? 0;
}

/**
 * Real-AWS verification of the S3 offload path through the public adapters.
 * Exercises PutObject / GetObject / DeleteObject / ListBucket against a real
 * bucket — round-trip fidelity, object placement, and orphan cleanup that
 * mocked unit tests cannot prove. Creates and tears down a unique table and
 * bucket per run. Lifecycle-rule provisioning and the S3 error taxonomy live
 * in real-aws-s3-lifecycle.test.ts, split out to stay under this repo's
 * per-file line cap.
 */
describe('S3 offload against real AWS', () => {
  let admin: DynamoDBClient;
  let s3: S3Client;
  let saver: DynamoDBSaver;
  let store: DynamoDBStore;

  beforeAll(async () => {
    admin = new DynamoDBClient(clientConfig);
    s3 = new S3Client(clientConfig);
    await admin.send(
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [
          { AttributeName: 'PK', AttributeType: 'S' },
          { AttributeName: 'SK', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
    await waitUntilTableExists({ client: admin, maxWaitTime: 90 }, { TableName: tableName });
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucketName,
        ...(region && region !== 'us-east-1'
          ? { CreateBucketConfiguration: { LocationConstraint: region as never } }
          : {}),
      }),
    );
    await waitUntilBucketExists({ client: s3, maxWaitTime: 90 }, { Bucket: bucketName });
    const s3Config = { bucketName, clientConfig };
    saver = new DynamoDBSaver({ tableName, clientConfig, s3: s3Config });
    store = new DynamoDBStore({ tableName, clientConfig, s3: s3Config });
  });

  afterAll(async () => {
    saver?.destroy();
    store?.destroy();
    await settleAll([
      async () => {
        if (!s3) return;
        await deleteBucketCompletely(s3, bucketName);
        s3.destroy();
      },
      async () => {
        if (!admin) return;
        await deleteTableCompletely(admin, tableName);
        admin.destroy();
      },
    ]);
  });

  it('offloads an over-limit checkpoint to S3 and reads it back byte-exact', async () => {
    const config = { configurable: { thread_id: 'big', checkpoint_ns: '' } };
    await saver.put(config, bigCheckpoint('cbig'), { source: 'input', step: 0, parents: {} });

    expect(await offloadedObjectCount(s3)).toBeGreaterThan(0);
    const tuple = await saver.getTuple({
      configurable: { thread_id: 'big', checkpoint_ns: '', checkpoint_id: 'cbig' },
    });
    expect(tuple?.checkpoint.channel_values).toEqual({ blob: bigPayload });
  });

  it('cleans up the offloaded S3 object when the thread is deleted', async () => {
    await saver.deleteThread('big');
    expect(await offloadedObjectCount(s3)).toBe(0);
  });

  it('offloads and restores an over-limit store value', async () => {
    await store.put(['mem', 'u1'], 'big', { blob: bigPayload });

    expect(await offloadedObjectCount(s3)).toBeGreaterThan(0);
    const item = await store.get(['mem', 'u1'], 'big');
    expect(item?.value).toEqual({ blob: bigPayload });
  });

  it('store.delete removes an offloaded item and its S3 object', async () => {
    await store.put(['mem', 'u1'], 'delete-me', { blob: bigPayload });
    const before = await offloadedObjectCount(s3);
    expect(before).toBeGreaterThan(0);

    await store.delete(['mem', 'u1'], 'delete-me');

    expect(await offloadedObjectCount(s3)).toBe(before - 1);
    expect(await store.get(['mem', 'u1'], 'delete-me')).toBeNull();
  });

  it('two concurrent putWrites racing the same (thread, checkpoint, task, index) never collide in S3', async () => {
    // Same taskId + channel means both calls target the identical DynamoDB row
    // (first-write-wins), but each still uploads to S3 before that race
    // resolves. The nonce-scoping fix keeps those two uploads at distinct
    // keys; without it, the loser's upload would silently overwrite the
    // winner's object out from under the row that still points at it.
    const threadId = 'concurrent-s3-race';
    await saver.put(
      { configurable: { thread_id: threadId, checkpoint_ns: '' } },
      bigCheckpoint('anchor'),
      { source: 'input', step: 0, parents: {} },
    );

    const before = await offloadedObjectCount(s3);
    const valueA = `A:${bigPayload}`;
    const valueB = `B:${bigPayload}`;
    const writeConfig = {
      configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: 'anchor' },
    };
    await Promise.all([
      saver.putWrites(writeConfig, [['ch', valueA]], 'task-race'),
      saver.putWrites(writeConfig, [['ch', valueB]], 'task-race'),
    ]);
    // Exactly one object survives: the winner's. The loser's guard rejection
    // returns the winner's row (ALL_OLD, a different writeGroup), which proves
    // the loser's own upload is unreferenced, so it is cleaned up rather than
    // left as an orphan (CKPT-09). Before that fix both objects remained.
    const after = await offloadedObjectCount(s3);
    expect(after - before).toBe(1);

    const tuple = await saver.getTuple({
      configurable: { thread_id: threadId, checkpoint_id: 'anchor' },
    });
    const values = (tuple?.pendingWrites ?? []).map(([, , value]) => value);
    expect(values).toHaveLength(1);
    expect([valueA, valueB]).toContain(values[0]);
  });

  it('never deletes the previous S3 object when a store overwrite put fails partway through (the CRITICAL fix)', async () => {
    const namespace = ['critical-fix', 'u1'];
    const key = 'doc';
    const originalPayload = randomBytes(512 * 1024).toString('base64');
    const overwritePayload = randomBytes(512 * 1024).toString('base64');
    await store.put(namespace, key, { blob: originalPayload });

    const before = await s3.send(
      new ListObjectsV2Command({ Bucket: bucketName, Prefix: KEY_PREFIX }),
    );
    const keysBefore = new Set((before.Contents ?? []).map((object) => object.Key));
    expect(keysBefore.size).toBeGreaterThan(0);

    const base = new DynamoDBClient(clientConfig);
    installFaults(base, [
      {
        match: (name) => name === 'PutItemCommand',
        fail: () =>
          Object.assign(new Error('injected overwrite failure'), { name: 'ValidationException' }),
        times: 1,
      },
    ]);
    const faultedStore = new DynamoDBStore({
      tableName,
      client: DynamoDBDocument.from(base),
      s3: { bucketName, clientConfig },
    });

    await expect(faultedStore.put(namespace, key, { blob: overwritePayload })).rejects.toThrow(
      'injected overwrite failure',
    );
    faultedStore.destroy();
    base.destroy();

    // The row must still point at the original, unharmed value — this is the
    // CRITICAL bug this fix closes: a failed overwrite must never leave the
    // still-live row pointing at a deleted S3 object.
    const stillThere = await store.get(namespace, key);
    expect(stillThere?.value).toEqual({ blob: originalPayload });

    // Every S3 object that existed before the failed overwrite — including the
    // original value's object — must still exist. The pre-fix deterministic key
    // would have made the failed overwrite's cleanup delete exactly this object.
    const after = await s3.send(
      new ListObjectsV2Command({ Bucket: bucketName, Prefix: KEY_PREFIX }),
    );
    const keysAfter = new Set((after.Contents ?? []).map((object) => object.Key));
    for (const objectKey of keysBefore) {
      expect(keysAfter.has(objectKey)).toBe(true);
    }
  });

  it('keeps a checkpoint readable when its put transaction commits but every response is lost (CKPT-01)', async () => {
    // Each TransactWriteItems attempt reaches DynamoDB and commits, but its
    // response is dropped, so the library exhausts its retry budget while the
    // rows are live. Before the fix, failure cleanup then deleted the S3 object
    // those rows point at and the checkpoint became permanently unreadable.
    const base = new DynamoDBClient({ ...clientConfig, maxAttempts: 1 });
    dropResponses(base, 'TransactWriteItemsCommand', DEFAULT_RETRY_MAX_ATTEMPTS);
    const faulted = new DynamoDBSaver({
      tableName,
      client: DynamoDBDocument.from(base),
      s3: { bucketName, clientConfig },
    });
    const threadId = 'lost-response';
    const before = await offloadedObjectCount(s3);

    const stored = await faulted.put(
      { configurable: { thread_id: threadId, checkpoint_ns: '' } },
      bigCheckpoint('lost'),
      { source: 'input', step: 0, parents: {} },
    );
    faulted.destroy();
    base.destroy();

    expect(stored.configurable?.checkpoint_id).toBe('lost');
    // The offloaded checkpoint object survives: nothing was deleted.
    expect(await offloadedObjectCount(s3)).toBe(before + 1);
    const tuple = await saver.getTuple({
      configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: 'lost' },
    });
    expect(tuple?.checkpoint.channel_values).toEqual({ blob: bigPayload });
  });
});
