import { randomUUID } from 'node:crypto';

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
  waitUntilBucketExists,
} from '@aws-sdk/client-s3';

import { DynamoDBSaver } from '../../src/index';
import { buildLifecycleRuleId, buildMarkerRuleId } from '../../src/shared/codec/s3/config';
import type { LogArgument, Logger } from '../../src/shared/logging/logger';
import { rejection } from './helpers/probe';
import { deleteBucketCompletely, settleAll } from './helpers/teardown';

const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
const clientConfig = region ? { region } : {};
const bucketName = `aws-langgraph-s3vertest-${randomUUID()}`;
const evidenceBucketName = `aws-langgraph-s3verevtest-${randomUUID()}`;

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

/**
 * Poll `GetBucketVersioning` until it reports `status`. Bucket-level
 * configuration is eventually consistent, the same reason
 * `real-aws-s3-lifecycle.test.ts` polls for its own rule reads.
 */
async function waitForVersioningStatus(
  s3: S3Client,
  bucket: string,
  status: string,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const state = await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }));
    if (state.Status === status) return;
    await sleep(1000);
  }
  throw new Error(`bucket versioning never reported ${status}`);
}

/**
 * Real-AWS verification of the versioning and delete-marker shapes the
 * containment layer is defined on (E-9, E-10, E-12 of `docs/evidence`),
 * probed directly against the raw SDK rather than through the adapters. A
 * bucket of its own: it moves through all three versioning states, which the
 * unversioned suite above deliberately does not.
 */
describe('versioning states, delete markers and suspension against real AWS', () => {
  let s3: S3Client;

  beforeAll(async () => {
    s3 = new S3Client(clientConfig);
    await s3.send(
      new CreateBucketCommand({
        Bucket: evidenceBucketName,
        ...(region && region !== 'us-east-1'
          ? { CreateBucketConfiguration: { LocationConstraint: region as never } }
          : {}),
      }),
    );
    await waitUntilBucketExists({ client: s3, maxWaitTime: 90 }, { Bucket: evidenceBucketName });
  });

  afterAll(async () => {
    await settleAll([
      async () => {
        if (!s3) return;
        await deleteBucketCompletely(s3, evidenceBucketName);
        s3.destroy();
      },
    ]);
  });

  /**
   * (docs/evidence/s3-versioning-and-lifecycle.md, E-9) — `GetBucketVersioning`
   * distinguishes never-versioned, enabled and suspended. Runs first in this
   * describe so the bucket is genuinely never-versioned when it starts.
   */
  it('E-9: GetBucketVersioning distinguishes never-versioned, enabled and suspended', async () => {
    const never = await s3.send(new GetBucketVersioningCommand({ Bucket: evidenceBucketName }));
    expect(never.Status).toBeUndefined();
    expect(never.$metadata.httpStatusCode).toBe(200);

    await s3.send(
      new PutBucketVersioningCommand({
        Bucket: evidenceBucketName,
        VersioningConfiguration: { Status: 'Enabled' },
      }),
    );
    await waitForVersioningStatus(s3, evidenceBucketName, 'Enabled');
    const enabled = await s3.send(new GetBucketVersioningCommand({ Bucket: evidenceBucketName }));
    expect(enabled.Status).toBe('Enabled');
  });

  /**
   * (docs/evidence/s3-versioning-and-lifecycle.md, E-10) — a delete on a
   * versioned bucket leaves a delete marker rather than erasing the object,
   * and the payload survives, readable by its version id. Runs while the
   * bucket is Enabled, which E-9 leaves it as.
   */
  it('E-10: a delete on a versioned bucket leaves a marker, and the prior version stays readable', async () => {
    const key = 'e10-delete-marker';
    const put = await s3.send(
      new PutObjectCommand({ Bucket: evidenceBucketName, Key: key, Body: 'the payload' }),
    );
    const originalVersionId = put.VersionId;
    expect(originalVersionId).toBeDefined();

    const del = await s3.send(new DeleteObjectCommand({ Bucket: evidenceBucketName, Key: key }));
    expect(del.DeleteMarker).toBe(true);

    const versionless = await rejection(
      s3.send(new GetObjectCommand({ Bucket: evidenceBucketName, Key: key })),
    );
    expect(versionless.name).toBe('NoSuchKey');

    const byVersion = await s3.send(
      new GetObjectCommand({ Bucket: evidenceBucketName, Key: key, VersionId: originalVersionId }),
    );
    expect(await byVersion.Body?.transformToString()).toBe('the payload');

    const listed = await s3.send(
      new ListObjectVersionsCommand({ Bucket: evidenceBucketName, Prefix: key }),
    );
    expect(
      (listed.DeleteMarkers ?? []).some((marker) => marker.Key === key && marker.IsLatest === true),
    ).toBe(true);
  });

  /**
   * (docs/evidence/s3-versioning-and-lifecycle.md, E-12) — under suspended
   * versioning, writes get a null version id, a second write there replaces
   * the first rather than accumulating, a delete leaves a null-version
   * delete marker, and a version written while versioning was Enabled
   * survives suspension untouched. Enables and suspends versioning itself
   * rather than assuming E-9's state, so this test stands on its own.
   */
  it('E-12: under suspended versioning, writes get a null version id and old versions survive untouched', async () => {
    await s3.send(
      new PutBucketVersioningCommand({
        Bucket: evidenceBucketName,
        VersioningConfiguration: { Status: 'Enabled' },
      }),
    );
    await waitForVersioningStatus(s3, evidenceBucketName, 'Enabled');

    const key = 'e12-suspension';
    const enabledEra = await s3.send(
      new PutObjectCommand({
        Bucket: evidenceBucketName,
        Key: key,
        Body: 'the enabled-era payload',
      }),
    );
    const enabledEraVersionId = enabledEra.VersionId;
    expect(enabledEraVersionId).toBeDefined();

    await s3.send(
      new PutBucketVersioningCommand({
        Bucket: evidenceBucketName,
        VersioningConfiguration: { Status: 'Suspended' },
      }),
    );
    await waitForVersioningStatus(s3, evidenceBucketName, 'Suspended');

    const firstSuspended = await s3.send(
      new PutObjectCommand({ Bucket: evidenceBucketName, Key: key, Body: 'suspended write 1' }),
    );
    expect(firstSuspended.VersionId).toBeUndefined();

    const secondSuspended = await s3.send(
      new PutObjectCommand({ Bucket: evidenceBucketName, Key: key, Body: 'suspended write 2' }),
    );
    expect(secondSuspended.VersionId).toBeUndefined();

    const deleted = await s3.send(
      new DeleteObjectCommand({ Bucket: evidenceBucketName, Key: key }),
    );
    expect(deleted.DeleteMarker).toBe(true);
    expect(deleted.VersionId).toBe('null');

    const afterDelete = await s3.send(
      new ListObjectVersionsCommand({ Bucket: evidenceBucketName, Prefix: key }),
    );
    // The second suspended write replaced the first's null version rather
    // than accumulating, and the delete then replaced that with a
    // null-version delete marker: no current version survives.
    expect((afterDelete.Versions ?? []).filter((version) => version.Key === key)).toHaveLength(0);
    expect(
      (afterDelete.DeleteMarkers ?? []).filter(
        (marker) => marker.Key === key && marker.VersionId === 'null',
      ),
    ).toHaveLength(1);

    const stillReadable = await s3.send(
      new GetObjectCommand({
        Bucket: evidenceBucketName,
        Key: key,
        VersionId: enabledEraVersionId,
      }),
    );
    expect(await stillReadable.Body?.transformToString()).toBe('the enabled-era payload');
  });
});
