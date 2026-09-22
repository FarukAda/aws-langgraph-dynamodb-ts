import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  S3Client,
  waitUntilBucketExists,
} from '@aws-sdk/client-s3';

import { DynamoDBStore } from '../../src/index';
import { report } from './helpers/probe';
import { createTestTable } from './helpers/table';
import { deleteBucketCompletely, deleteTableCompletely, settleAll } from './helpers/teardown';

const run = promisify(execFile);
const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
const clientConfig = region ? { region } : {};
const suffix = randomUUID();
const tableName = `aws-langgraph-sweeptest-${suffix}`;
const bucketName = `aws-langgraph-sweeptest-${suffix}`;
const KEY_PREFIX = 'sweep-test/';
const SCRIPT = resolve(__dirname, '../../scripts/find-stranded-payloads.mjs');
const NAMESPACE = ['sweep', 'u1'];

/** ~683 KB of incompressible data, over the 350 KB offload threshold whatever gzip does to it. */
const bigPayload = randomBytes(512 * 1024).toString('base64');

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** One object version or delete marker, as an identity two listings can be compared on. */
interface Entry {
  key: string;
  versionId: string;
  marker: boolean;
}

/** Every version and delete marker under the suite's prefix, in listing order. */
async function listAll(s3: S3Client): Promise<Entry[]> {
  const page = await s3.send(
    new ListObjectVersionsCommand({ Bucket: bucketName, Prefix: KEY_PREFIX }),
  );
  const of = (marker: boolean) =>
    (marker ? (page.DeleteMarkers ?? []) : (page.Versions ?? [])).map((entry) => ({
      key: String(entry.Key),
      versionId: String(entry.VersionId),
      marker,
    }));
  return [...of(false), ...of(true)];
}

/**
 * Turn versioning on and wait until the bucket reports it.
 *
 * Bucket-level configuration is eventually consistent — `real-aws-s3-lifecycle.test.ts`
 * polls for the same reason — and here the consequence is worse than a stale
 * read: an object written before versioning takes effect gets the null version,
 * and deleting it destroys the payload outright instead of leaving it behind a
 * delete marker. There would then be nothing for the sweep to find, and the
 * failure would look like a defect in the sweep rather than in the setup.
 */
async function enableVersioning(s3: S3Client): Promise<void> {
  await s3.send(
    new PutBucketVersioningCommand({
      Bucket: bucketName,
      VersioningConfiguration: { Status: 'Enabled' },
    }),
  );
  for (let attempt = 0; attempt < 10; attempt++) {
    const state = await s3.send(new GetBucketVersioningCommand({ Bucket: bucketName }));
    if (state.Status === 'Enabled') return;
    await sleep(1000);
  }
  throw new Error('bucket versioning never reported Enabled');
}

/**
 * L7 (design §8.3) — the stranded-payload sweep, end to end against a real
 * versioned bucket and a real table. The one item in §8.3 that had never been
 * run at all.
 *
 * A release on a versioned bucket does not erase the object: it leaves a delete
 * marker with the payload surviving behind it as a noncurrent version until the
 * lifecycle grace expires. That window is the only time a stranded row — one
 * still live, still naming an object whose payload was released — can be found
 * cheaply, and the whole containment layer is defined on it. Unversioned, there
 * is no sweep to test, which is why this suite owns a bucket of its own and
 * turns versioning on.
 *
 * The script is driven as the **command line**, not through its exported
 * functions, because it is an ESM `.mjs` module and this jest tier transpiles to
 * CommonJS: a `.ts` test here cannot import it at all, which is why its unit
 * tests run under `node --test` instead (`test/scripts/find-stranded-payloads.test.mjs`).
 * Spawning is the only way to reach this path from this tier, and it has the
 * side benefit of exercising argument parsing, the bounded client config and
 * the report format an operator actually reads.
 */
describe('the stranded-payload sweep against real AWS', () => {
  let admin: DynamoDBClient;
  let s3: S3Client;
  let store: DynamoDBStore;
  let strandedKey: string;
  let goneKey: string;
  let backlink: { pk: string; sk: string };

  beforeAll(async () => {
    admin = new DynamoDBClient(clientConfig);
    s3 = new S3Client(clientConfig);
    await createTestTable(admin, tableName);
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucketName,
        ...(region && region !== 'us-east-1'
          ? { CreateBucketConfiguration: { LocationConstraint: region as never } }
          : {}),
      }),
    );
    await waitUntilBucketExists({ client: s3, maxWaitTime: 90 }, { Bucket: bucketName });
    await enableVersioning(s3);
    store = new DynamoDBStore({
      tableName,
      clientConfig,
      s3: { bucketName, clientConfig, keyPrefix: KEY_PREFIX },
    });
  });

  afterAll(async () => {
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

  /**
   * The two cases the sweep has to tell apart, built with the library rather
   * than by hand so the object layout, the backlink metadata and the row's
   * descriptor are the ones this release really writes.
   *
   * The stranded one is a live row whose object was released out from under it,
   * which is exactly what a `deleteThread` racing a write used to leave behind.
   * The gone one is an ordinary `store.delete`: row and object both away, the
   * case that must produce no report at all.
   */
  it('leaves one stranded row and one row that is genuinely gone', async () => {
    await store.put(NAMESPACE, 'stranded', { blob: bigPayload });
    const [payload] = await listAll(s3);
    strandedKey = payload.key;
    // The null version id would mean versioning had not taken effect when this
    // was written, and the delete below would destroy the payload rather than
    // strand it.
    expect(payload.versionId).not.toBe('null');

    const head = await s3.send(
      new HeadObjectCommand({ Bucket: bucketName, Key: strandedKey, VersionId: payload.versionId }),
    );
    const decode = (value: string | undefined): string =>
      Buffer.from(String(value), 'base64url').toString('utf8');
    backlink = {
      pk: decode(head.Metadata?.['dynamodb-pk-b64']),
      sk: decode(head.Metadata?.['dynamodb-sk-b64']),
    };
    // Without this pair on the object the sweep has no way back to the row, so
    // it is asserted here rather than inferred from the report.
    expect(backlink.pk.length).toBeGreaterThan(0);
    expect(backlink.sk.length).toBeGreaterThan(0);

    await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: strandedKey }));

    await store.put(NAMESPACE, 'gone', { blob: bigPayload });
    goneKey = (await listAll(s3)).filter((entry) => entry.key !== strandedKey)[0].key;
    await store.delete(NAMESPACE, 'gone');

    const entries = await listAll(s3);
    expect(entries.filter((entry) => entry.marker)).toHaveLength(2);
    expect(entries.filter((entry) => !entry.marker)).toHaveLength(2);
  });

  /**
   * The sweep itself: it must name the stranded row, say nothing at all about
   * the row that is genuinely gone, and repair neither.
   *
   * "Repairs nothing" is the property that lets an operator run it on a
   * production bucket during an incident. It is asserted on the account rather
   * than on the report — the object listing is identical before and after, and
   * the stranded row is still there — because a script that printed the right
   * words while deleting a version would pass every assertion about its output.
   */
  it('reports the stranded row, reports nothing for the deleted one, and repairs neither', async () => {
    const before = await listAll(s3);
    const { stdout } = await run(process.execPath, [
      SCRIPT,
      '--bucket',
      bucketName,
      '--table',
      tableName,
      '--prefix',
      KEY_PREFIX,
      ...(region === undefined ? [] : ['--region', region]),
    ]);
    report(stdout.trimEnd());

    const stranded = stdout.split('\n').filter((line) => line.startsWith('STRANDED'));
    expect(stranded).toHaveLength(1);
    expect(stranded[0]).toContain(`objectKey=${strandedKey}`);
    expect(stranded[0]).toContain(`pk=${JSON.stringify(backlink.pk)}`);
    expect(stranded[0]).toContain(`sk=${JSON.stringify(backlink.sk)}`);
    expect(stdout).toContain('1 stranded row(s)');
    expect(stdout).toContain('This script repairs nothing.');
    // The deleted item's key appears nowhere: not as stranded, not as
    // unreadable. A row that is gone is not a finding.
    expect(stdout).not.toContain(goneKey);

    expect(await listAll(s3)).toEqual(before);
    const row = await admin.send(
      new GetItemCommand({
        TableName: tableName,
        Key: { PK: { S: backlink.pk }, SK: { S: backlink.sk } },
        ConsistentRead: true,
      }),
    );
    expect(row.Item).toBeDefined();
  });
});
