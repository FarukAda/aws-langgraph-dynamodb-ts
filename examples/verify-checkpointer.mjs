/**
 * Full real-AWS acceptance run for DynamoDBSaver. Exercises every feature and
 * edge case against REAL DynamoDB + REAL S3, asserting each outcome. Creates
 * and tears down all resources. Exits non-zero if any check fails.
 *
 * Run: node examples/verify-checkpointer.mjs
 */
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { isDeepStrictEqual } from 'node:util';

import { DynamoDBSaver } from '../dist/index.js';

const REGION = 'eu-west-1';
const TABLE = 'langgraph-verify-checkpointer';
const BUCKET = 'langgraph-verify-712098997573-euw1';
const clientConfig = { region: REGION };
const admin = new DynamoDBClient(clientConfig);
const doc = DynamoDBDocument.from(admin);
const s3 = new S3Client(clientConfig);

let passed = 0;
let failed = 0;
function check(label, ok) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}`);
  }
}
async function expectThrow(label, fn, codeOrName) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, error.code === codeOrName || error.name === codeOrName);
  }
}

function cp(id, values, ts = '2024-01-01T00:00:00.000Z') {
  return { v: 4, id, ts, channel_values: values, channel_versions: {}, versions_seen: {} };
}
const meta = (source, step) => ({ source, step, parents: {} });
const cfg = (thread, ns, id) => ({
  configurable: { thread_id: thread, checkpoint_ns: ns ?? '', ...(id ? { checkpoint_id: id } : {}) },
});

async function readItem(thread, sk) {
  const r = await doc.get({ TableName: TABLE, Key: { PK: thread, SK: sk } });
  return r.Item;
}

async function setup() {
  try {
    await admin.send(
      new CreateTableCommand({
        TableName: TABLE,
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
    await waitUntilTableExists({ client: admin, maxWaitTime: 60 }, { TableName: TABLE });
  } catch (e) {
    if (e.name !== 'ResourceInUseException') throw e;
  }
  await admin.send(
    new UpdateTimeToLiveCommand({
      TableName: TABLE,
      TimeToLiveSpecification: { Enabled: true, AttributeName: 'ttl' },
    }),
  );
  try {
    await s3.send(
      new CreateBucketCommand({ Bucket: BUCKET, CreateBucketConfiguration: { LocationConstraint: REGION } }),
    );
  } catch (e) {
    if (e.name !== 'BucketAlreadyOwnedByYou' && e.name !== 'BucketAlreadyExists') throw e;
  }
}

async function teardown() {
  await admin.send(new DeleteTableCommand({ TableName: TABLE }));
  try {
    const objs = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }));
    if (objs.Contents?.length) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET,
          Delete: { Objects: objs.Contents.map((o) => ({ Key: o.Key })) },
        }),
      );
    }
    await s3.send(new DeleteBucketCommand({ Bucket: BUCKET }));
  } catch {
    /* best effort */
  }
  admin.destroy();
  s3.destroy();
}

async function run() {
  await setup();
  const saver = new DynamoDBSaver({ tableName: TABLE, clientConfig });

  console.log('\n[A] core round-trip, resume, parent, pending writes');
  await saver.put(cfg('A'), cp('cp-001', { msg: 'one' }), meta('input', 1), {});
  let t = await saver.getTuple(cfg('A'));
  check('getTuple returns stored checkpoint values', isDeepStrictEqual(t.checkpoint.channel_values, { msg: 'one' }));
  check('getTuple returns stored metadata', isDeepStrictEqual(t.metadata, meta('input', 1)));
  check('no pending writes initially', isDeepStrictEqual(t.pendingWrites, []));
  const fresh = new DynamoDBSaver({ tableName: TABLE, clientConfig });
  const t2 = await fresh.getTuple(cfg('A'));
  check('a brand-new saver resumes from DynamoDB', t2.checkpoint.id === 'cp-001');
  fresh.destroy();
  await saver.putWrites(cfg('A', '', 'cp-001'), [['ch1', 'w0'], ['ch2', 'w1']], 'task-1');
  await saver.putWrites(cfg('A', '', 'cp-001'), [['ch3', 'w2']], 'task-2');
  t = await saver.getTuple(cfg('A', '', 'cp-001'));
  check('pending writes recorded with task ids in order', isDeepStrictEqual(t.pendingWrites, [
    ['task-1', 'ch1', 'w0'],
    ['task-1', 'ch2', 'w1'],
    ['task-2', 'ch3', 'w2'],
  ]));
  await saver.put(cfg('A', '', 'cp-001'), cp('cp-002', { msg: 'two' }), meta('loop', 2), {});
  const latest = await saver.getTuple(cfg('A'));
  check('latest checkpoint is the newest', latest.checkpoint.id === 'cp-002');
  check('parent config links to previous checkpoint', latest.parentConfig.configurable.checkpoint_id === 'cp-001');

  console.log('\n[B] list: order, limit, before, filter');
  const ids = async (opts) => {
    const out = [];
    for await (const x of saver.list(cfg('A'), opts)) out.push(x.checkpoint.id);
    return out;
  };
  check('list newest-first', isDeepStrictEqual(await ids(), ['cp-002', 'cp-001']));
  check('list limit', isDeepStrictEqual(await ids({ limit: 1 }), ['cp-002']));
  check('list before', isDeepStrictEqual(await ids({ before: cfg('A', '', 'cp-002') }), ['cp-001']));
  check('list filter match', isDeepStrictEqual(await ids({ filter: { source: 'input' } }), ['cp-001']));
  check('list filter no match -> empty', isDeepStrictEqual(await ids({ filter: { source: 'nope' } }), []));

  console.log('\n[C] namespace isolation');
  await saver.put(cfg('NS', 'branch'), cp('cp-b', { who: 'branch' }), meta('loop', 1), {});
  await saver.put(cfg('NS', ''), cp('cp-root', { who: 'root' }), meta('loop', 1), {});
  check('namespace "" sees only its checkpoint', (await saver.getTuple(cfg('NS', ''))).checkpoint.channel_values.who === 'root');
  check('namespace "branch" sees only its checkpoint', (await saver.getTuple(cfg('NS', 'branch'))).checkpoint.channel_values.who === 'branch');

  console.log('\n[D] special / large values round-trip');
  const tricky = { text: 'héllo 🌍 \n\t"q"', nested: { a: [1, 2, { b: null }] }, big: 9007199254740991, f: 3.14159, empty: '' };
  await saver.put(cfg('SP'), cp('cp-sp', tricky), meta('loop', 1), {});
  check('unicode/nested/null/number/empty-string round-trip exactly', isDeepStrictEqual((await saver.getTuple(cfg('SP'))).checkpoint.channel_values, tricky));

  console.log('\n[E] gzip compression (stored bytes shrink, value intact)');
  const csaver = new DynamoDBSaver({ tableName: TABLE, clientConfig, compression: { enabled: true } });
  const bigValue = { blob: 'x'.repeat(50000) };
  await csaver.put(cfg('CMP'), cp('cp-cmp', bigValue), meta('loop', 1), {});
  const cItem = await readItem('CMP', 'PAYLOAD##cp-cmp');
  check('compressed payload stored inline', cItem.checkpoint.location === 'INLINE');
  check('compressed bytes much smaller than 50KB raw', cItem.checkpoint.bytes.length < 5000);
  check('compressed checkpoint round-trips intact', isDeepStrictEqual((await csaver.getTuple(cfg('CMP'))).checkpoint.channel_values, bigValue));
  csaver.destroy();

  console.log('\n[F] S3 offload (real bucket) + rehydrate + orphan cleanup on delete');
  const osaver = new DynamoDBSaver({ tableName: TABLE, clientConfig, s3: { bucketName: BUCKET, thresholdBytes: 1024 } });
  const offloadValue = { blob: 'y'.repeat(60000), n: 7 };
  await osaver.put(cfg('S3'), cp('cp-s3', offloadValue), meta('loop', 1), {});
  const oItem = await readItem('S3', 'PAYLOAD##cp-s3');
  check('large payload offloaded to S3 (location=S3)', oItem.checkpoint.location === 'S3');
  check('payload item stores an s3 key', typeof oItem.checkpoint.s3Key === 'string');
  let s3Exists = false;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: oItem.checkpoint.s3Key }));
    s3Exists = true;
  } catch {
    s3Exists = false;
  }
  check('offloaded object actually exists in S3', s3Exists);
  check('getTuple rehydrates the value from S3', isDeepStrictEqual((await osaver.getTuple(cfg('S3'))).checkpoint.channel_values, offloadValue));
  await osaver.deleteThread('S3');
  let s3Gone = false;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: oItem.checkpoint.s3Key }));
  } catch (e) {
    s3Gone = e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
  }
  check('deleteThread removed the orphaned S3 object', s3Gone);
  check('deleteThread removed the checkpoint', (await osaver.getTuple(cfg('S3'))) === undefined);
  osaver.destroy();

  console.log('\n[G] TTL attribute written');
  const tsaver = new DynamoDBSaver({ tableName: TABLE, clientConfig, ttl: { seconds: 3600 } });
  await tsaver.put(cfg('TTL'), cp('cp-ttl', { x: 1 }), meta('loop', 1), {});
  const ttlItem = await readItem('TTL', 'META##cp-ttl');
  const expectedTtl = Math.floor(Date.now() / 1000) + 3600;
  check('ttl attribute set to ~now+3600s', Math.abs(ttlItem.ttl - expectedTtl) < 120);
  tsaver.destroy();

  console.log('\n[H] edge cases');
  check('getTuple on unknown thread -> undefined', (await saver.getTuple(cfg('NOPE'))) === undefined);
  await saver.deleteThread('also-unknown');
  check('deleteThread on empty thread does not throw', true);
  await expectThrow('putWrites without checkpoint_id throws VALIDATION', () => saver.putWrites(cfg('A'), [['c', 1]], 'task'), 'VALIDATION');
  await saver.deleteThread('A');
  check('deleteThread purges the whole thread', (await saver.getTuple(cfg('A'))) === undefined && isDeepStrictEqual(await ids(), []));

  saver.destroy();
  await teardown();

  console.log(`\n==== ${passed} passed, ${failed} failed ====`);
  if (failed > 0) process.exitCode = 1;
}

run().catch(async (e) => {
  console.error('\nVERIFY CRASHED:', e);
  try {
    await teardown();
  } catch {
    /* best effort */
  }
  process.exitCode = 1;
});
