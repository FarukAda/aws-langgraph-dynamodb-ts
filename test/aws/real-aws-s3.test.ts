import { randomBytes, randomUUID } from 'node:crypto';

import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
  waitUntilTableNotExists,
} from '@aws-sdk/client-dynamodb';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetBucketLifecycleConfigurationCommand,
  ListObjectsV2Command,
  S3Client,
  waitUntilBucketExists,
  waitUntilBucketNotExists,
} from '@aws-sdk/client-s3';
import type { Checkpoint } from '@langchain/langgraph-checkpoint';

import { DynamoDBChatMessageHistory, DynamoDBSaver, DynamoDBStore } from '../../src/index';
import { buildLifecycleRuleId } from '../../src/shared/codec/s3/config';

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
 * S3 bucket-level config (unlike object reads) is eventually consistent: a
 * `GetBucketLifecycleConfiguration` right after a `Put` can still return the
 * previous rule set. Poll until it converges rather than asserting on a
 * single read. `keyPrefix` (and hence the rule id it produces) must be
 * distinct per caller so "converged" can never be confused with "still
 * showing a different rule's value" from an earlier write to the same rule.
 */
async function waitForLifecycleRuleDays(
  s3: S3Client,
  keyPrefix: string,
  expectedDays: number,
  attempts = 10,
  delayMs = 1000,
): Promise<{ Status?: string; Expiration?: { Days?: number } } | undefined> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const raw = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucketName }));
      const rule = (raw.Rules ?? []).find((r) => r.ID === buildLifecycleRuleId(keyPrefix));
      if (rule?.Expiration?.Days === expectedDays) return rule;
    } catch (error) {
      if ((error as { name?: string }).name !== 'NoSuchLifecycleConfiguration') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Lifecycle rule never converged to ${expectedDays} days`);
}

/**
 * Real-AWS verification of the S3 offload path through the public adapters.
 * Exercises PutObject / GetObject / DeleteObject / ListBucket against a real
 * bucket — round-trip fidelity, object placement, and orphan cleanup that
 * mocked unit tests cannot prove. Creates and tears down a unique table and
 * bucket per run.
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
    if (s3) {
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucketName }));
      const objects = (listed.Contents ?? []).map((object) => ({ Key: object.Key as string }));
      if (objects.length > 0) {
        await s3.send(
          new DeleteObjectsCommand({ Bucket: bucketName, Delete: { Objects: objects } }),
        );
      }
      await s3.send(new DeleteBucketCommand({ Bucket: bucketName }));
      await waitUntilBucketNotExists({ client: s3, maxWaitTime: 90 }, { Bucket: bucketName });
      s3.destroy();
    }
    if (admin) {
      await admin.send(new DeleteTableCommand({ TableName: tableName }));
      await waitUntilTableNotExists({ client: admin, maxWaitTime: 90 }, { TableName: tableName });
      admin.destroy();
    }
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

  it('ensureS3LifecycleRule provisions a real, independently verifiable bucket rule', async () => {
    const prefix = 'saver-ttl-test/';
    const ttlSaver = new DynamoDBSaver({
      tableName,
      clientConfig,
      ttl: { days: 30 },
      s3: { bucketName, clientConfig, keyPrefix: prefix },
    });

    await ttlSaver.ensureS3LifecycleRule();
    ttlSaver.destroy();

    const rule = await waitForLifecycleRuleDays(s3, prefix, 30);
    expect(rule?.Status).toBe('Enabled');
  });

  it('store.ensureS3LifecycleRule provisions its own real, verifiable bucket rule', async () => {
    const prefix = 'store-ttl-test/';
    const ttlStore = new DynamoDBStore({
      tableName,
      clientConfig,
      ttl: { days: 45 },
      s3: { bucketName, clientConfig, keyPrefix: prefix },
    });

    await ttlStore.ensureS3LifecycleRule();
    ttlStore.destroy();

    const rule = await waitForLifecycleRuleDays(s3, prefix, 45);
    expect(rule?.Status).toBe('Enabled');
  });

  it('history.ensureS3LifecycleRule provisions its own real, verifiable bucket rule', async () => {
    const prefix = 'history-ttl-test/';
    const ttlHistory = new DynamoDBChatMessageHistory({
      tableName,
      clientConfig,
      ttl: { days: 60 },
      s3: { bucketName, clientConfig, keyPrefix: prefix },
    });

    await ttlHistory.ensureS3LifecycleRule();
    ttlHistory.destroy();

    const rule = await waitForLifecycleRuleDays(s3, prefix, 60);
    expect(rule?.Status).toBe('Enabled');
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
    const after = await offloadedObjectCount(s3);
    expect(after - before).toBe(2);

    const tuple = await saver.getTuple({
      configurable: { thread_id: threadId, checkpoint_id: 'anchor' },
    });
    const values = (tuple?.pendingWrites ?? []).map(([, , value]) => value);
    expect(values).toHaveLength(1);
    expect([valueA, valueB]).toContain(values[0]);
  });
});
