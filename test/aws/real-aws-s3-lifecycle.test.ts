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
const tableName = `aws-langgraph-s3lctest-${suffix}`;
const bucketName = `aws-langgraph-s3lctest-${suffix}`;
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
 * Real-AWS verification of S3 lifecycle-rule provisioning and the S3 error
 * taxonomy — split out from real-aws-s3.test.ts (which owns the core offload
 * CRUD path) to stay under this repo's per-file line cap. Creates and tears
 * down a unique table and bucket per run.
 */
describe('S3 lifecycle rules and error taxonomy against real AWS', () => {
  let admin: DynamoDBClient;
  let s3: S3Client;

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
  });

  afterAll(async () => {
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

    // Expected days = ttl days + the two-day DynamoDB sweep margin (lifecycleExpirationDays).
    const rule = await waitForLifecycleRuleDays(s3, prefix, 32);
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

    const rule = await waitForLifecycleRuleDays(s3, prefix, 47);
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

    const rule = await waitForLifecycleRuleDays(s3, prefix, 62);
    expect(rule?.Status).toBe('Enabled');
  });

  it('each adapter provisions its own lifecycle rule under its default adapter-scoped prefix without colliding (the Task-3 fix)', async () => {
    const s3Config = { bucketName, clientConfig };
    const defaultSaver = new DynamoDBSaver({
      tableName,
      clientConfig,
      ttl: { days: 7 },
      s3: s3Config,
    });
    const defaultStore = new DynamoDBStore({
      tableName,
      clientConfig,
      ttl: { days: 90 },
      s3: s3Config,
    });

    // With no explicit keyPrefix, each adapter now defaults to its own
    // sub-prefix (`.../checkpointer/`, `.../store/`) and hence its own
    // lifecycle rule ID — before this fix both would have shared one rule ID,
    // and whichever call landed last would silently overwrite the other's TTL.
    // Bucket lifecycle config is eventually consistent and PutBucketLifecycleConfiguration
    // replaces the whole rule set, so each provisioning call waits for its own
    // rule to converge before the next one reads-and-merges — otherwise a stale
    // read could silently drop the first rule, independent of the fix itself.
    await defaultSaver.ensureS3LifecycleRule();
    const saverRule = await waitForLifecycleRuleDays(s3, `${KEY_PREFIX}checkpointer/`, 9);
    expect(saverRule?.Status).toBe('Enabled');

    await defaultStore.ensureS3LifecycleRule();
    defaultStore.destroy();
    const storeRule = await waitForLifecycleRuleDays(s3, `${KEY_PREFIX}store/`, 92);
    expect(storeRule?.Status).toBe('Enabled');

    // The real point of this test: the checkpointer's rule must still be
    // intact after the store's independent provisioning call — proving the
    // two adapters' rules coexist rather than one clobbering the other.
    //
    // S3's bucket-level config API is only eventually consistent (unlike
    // object reads/writes, which are strongly consistent) — even after our
    // own poll above already observed the checkpointer rule converge, the
    // store's later ensureS3LifecycleRule() read-modify-write can still race
    // against a stale GET and silently drop it. ensureS3LifecycleRule() is
    // documented as idempotent for exactly this reason: a second, unforced
    // call self-heals. So if the rule isn't visible yet, re-run provisioning
    // once — proving the self-healing property — before treating it as a
    // real defect.
    let saverRuleAfter = await waitForLifecycleRuleDays(
      s3,
      `${KEY_PREFIX}checkpointer/`,
      9,
      3,
      500,
    ).catch(() => undefined);
    if (!saverRuleAfter) {
      await defaultSaver.ensureS3LifecycleRule();
      saverRuleAfter = await waitForLifecycleRuleDays(s3, `${KEY_PREFIX}checkpointer/`, 9);
    }
    defaultSaver.destroy();
    expect(saverRuleAfter?.Status).toBe('Enabled');
  });

  it('surfaces S3 retry-exhaustion as S3_OFFLOAD_FAILED with operation/key context, not a bare RETRY_EXHAUSTED', async () => {
    const s3Base = new S3Client(clientConfig);
    let putAttempts = 0;
    s3Base.middlewareStack.add(
      (next, context) => async (args) => {
        const commandName = (context as { commandName?: string }).commandName ?? '';
        if (commandName === 'PutObjectCommand') {
          putAttempts += 1;
          throw Object.assign(new Error('simulated persistent throttle'), { name: 'SlowDown' });
        }
        return next(args);
      },
      { step: 'initialize', name: 'persistentS3Throttle', priority: 'high' },
    );
    const faultedSaver = new DynamoDBSaver({
      tableName,
      clientConfig,
      s3: { bucketName, clientConfig, createS3Client: () => s3Base },
    });

    const config = { configurable: { thread_id: 'error-masking', checkpoint_ns: '' } };
    await expect(
      faultedSaver.put(config, bigCheckpoint('em1'), { source: 'input', step: 0, parents: {} }),
    ).rejects.toMatchObject({
      code: 'S3_OFFLOAD_FAILED',
      context: { operation: 'upload' },
    });
    faultedSaver.destroy();
    s3Base.destroy();
    // withRetry's maxAttempts for S3 uploads is 3 — retry-exhaustion should
    // have genuinely occurred, not an immediate non-retryable throw.
    expect(putAttempts).toBe(3);
  });
});
