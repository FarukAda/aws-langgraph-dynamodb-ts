import { randomUUID } from 'node:crypto';

import {
  CreateBucketCommand,
  GetBucketLifecycleConfigurationCommand,
  S3Client,
  waitUntilBucketExists,
} from '@aws-sdk/client-s3';

import { DynamoDBSaver } from '../../src/index';
import { buildLifecycleRuleId, buildMarkerRuleId } from '../../src/shared/codec/s3/config';
import type { LogArgument, Logger } from '../../src/shared/logging/logger';
import { deleteBucketCompletely, settleAll } from './helpers/teardown';

const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
const clientConfig = region ? { region } : {};
const bucketName = `aws-langgraph-s3vertest-${randomUUID()}`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A logger that keeps every warning an adapter emitted, message first. */
interface CapturingLogger extends Logger {
  warnings: [string, ...LogArgument[]][];
}

function capturingLogger(): CapturingLogger {
  const warnings: [string, ...LogArgument[]][] = [];
  return {
    warnings,
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: (message, ...args) => {
      warnings.push([message, ...args]);
    },
  };
}

/**
 * The adapter's two rules, once the bucket reports them. Bucket-level config
 * is eventually consistent, so this polls: a single read cannot tell a rule
 * that was never written from one that has not propagated yet.
 */
async function waitForBothRules(s3: S3Client, keyPrefix: string): Promise<string[]> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const raw = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucketName }));
      const ids = (raw.Rules ?? []).flatMap((rule) => (rule.ID === undefined ? [] : [rule.ID]));
      const wanted = [buildLifecycleRuleId(keyPrefix), buildMarkerRuleId(keyPrefix)];
      if (wanted.every((id) => ids.includes(id))) return wanted;
    } catch (error) {
      if ((error as { name?: string }).name !== 'NoSuchLifecycleConfiguration') throw error;
    }
    await sleep(1000);
  }
  throw new Error(`Both lifecycle rules of ${keyPrefix} never converged`);
}

/**
 * Real-AWS verification that an **unversioned** bucket — what `CreateBucket`
 * makes, and what most deployments have — is reported rather than refused.
 * A bucket of its own, never versioned, because that state is the whole point
 * and the lifecycle suite's bucket is shared with other cases.
 *
 * The suspended state is deliberately not exercised here: reaching it needs
 * `s3:PutBucketVersioning`, an action this library never calls and the test
 * role need not carry. Its branch is covered by the unit suite.
 */
describe('an unversioned offload bucket against real AWS', () => {
  let s3: S3Client;

  beforeAll(async () => {
    s3 = new S3Client(clientConfig);
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
    await settleAll([
      async () => {
        if (!s3) return;
        await deleteBucketCompletely(s3, bucketName);
        s3.destroy();
      },
    ]);
  });

  /**
   * The containment is missing, the prevention layer is not: refusing here
   * would leave the buckets that most need reclamation without any rule at
   * all, and would break every rc.1 deployment on upgrade.
   */
  it('still writes both lifecycle rules, and does not throw', async () => {
    const prefix = 'unversioned-writes/';
    const logger = capturingLogger();
    const saver = new DynamoDBSaver({
      tableName: 'unused-by-this-call',
      clientConfig,
      logger,
      ttl: { days: 30 },
      s3: { bucketName, clientConfig, keyPrefix: prefix },
    });

    await expect(saver.ensureS3LifecycleRule()).resolves.toBeUndefined();
    saver.destroy();
    const ids = await waitForBothRules(s3, prefix);
    expect(ids).toHaveLength(2);
  });

  it('warns that the bucket keeps no versions, naming the remedy', async () => {
    const prefix = 'unversioned-warns/';
    const logger = capturingLogger();
    const saver = new DynamoDBSaver({
      tableName: 'unused-by-this-call',
      clientConfig,
      logger,
      ttl: { days: 30 },
      s3: { bucketName, clientConfig, keyPrefix: prefix },
    });

    await saver.ensureS3LifecycleRule();
    saver.destroy();
    await waitForBothRules(s3, prefix);
    // Named first, so a role without s3:GetBucketVersioning fails this gate on
    // its own cause rather than on an empty filter two lines down.
    expect(logger.warnings.filter(([m]) => m.includes('could not read'))).toHaveLength(0);
    const versioning = logger.warnings.filter(([message]) => message.includes('versioning is off'));
    expect(versioning).toHaveLength(1);
    expect(versioning[0][0]).toContain('enable bucket versioning');
    expect(versioning[0][1]).toEqual({ bucket: bucketName });
  });
});
