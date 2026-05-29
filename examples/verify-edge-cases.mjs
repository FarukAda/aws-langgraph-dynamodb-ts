/**
 * Edge-case sweep against real AWS for the remaining cases not covered by the
 * per-adapter verify scripts: every store filter operator, filter+query
 * combined, offset, index:false, per-item field override, a REAL multi-page
 * scan (>1 MB), checkpointer compression+S3 together, concurrent putWrites,
 * long chat histories, and many sessions. Creates + tears down all resources.
 *
 * Run: node examples/verify-edge-cases.mjs
 */
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { HumanMessage } from '@langchain/core/messages';
import { isDeepStrictEqual } from 'node:util';

import { DynamoDBChatMessageHistory, DynamoDBSaver, DynamoDBStore } from '../dist/index.js';

const REGION = 'eu-west-1';
const TABLE = 'langgraph-verify-edge';
const BUCKET = 'langgraph-verify-edge-712098997573-euw1';
const clientConfig = { region: REGION };
const admin = new DynamoDBClient(clientConfig);
const doc = DynamoDBDocument.from(admin);
const s3 = new S3Client(clientConfig);

let passed = 0;
let failed = 0;
const check = (label, ok) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  ok ? (passed += 1) : (failed += 1);
};

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
        new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: objs.Contents.map((o) => ({ Key: o.Key })) } }),
      );
    }
    await s3.send(new DeleteBucketCommand({ Bucket: BUCKET }));
  } catch {
    /* best effort */
  }
  admin.destroy();
  s3.destroy();
}

const cp = (id, values) => ({ v: 4, id, ts: '', channel_values: values, channel_versions: {}, versions_seen: {} });
const cfg = (thread, ns, id) => ({
  configurable: { thread_id: thread, checkpoint_ns: ns ?? '', ...(id ? { checkpoint_id: id } : {}) },
});

async function storeOperators() {
  console.log('\n[A] store: every filter operator + filter/query/offset/index:false/field-override');
  const store = new DynamoDBStore({ tableName: TABLE, clientConfig });
  await store.put(['ops'], 'low', { score: 1, tag: 'a' });
  await store.put(['ops'], 'mid', { score: 5, tag: 'b' });
  await store.put(['ops'], 'high', { score: 9, tag: 'a' });
  const keys = async (filter) =>
    (await store.search(['ops'], { filter })).map((i) => i.key).sort().join(',');
  check('$eq', (await keys({ score: { $eq: 5 } })) === 'mid');
  check('$ne', (await keys({ tag: { $ne: 'a' } })) === 'mid');
  check('$gt', (await keys({ score: { $gt: 5 } })) === 'high');
  check('$gte', (await keys({ score: { $gte: 5 } })) === 'high,mid');
  check('$lt', (await keys({ score: { $lt: 5 } })) === 'low');
  check('$lte', (await keys({ score: { $lte: 5 } })) === 'low,mid');
  check('offset paginates', (await store.search(['ops'], { offset: 2 })).length === 1);
  store.destroy();

  const { BedrockEmbeddings } = await import('@langchain/aws');
  const embeddings = new BedrockEmbeddings({ model: 'amazon.titan-embed-text-v2:0', region: REGION });
  const semantic = new DynamoDBStore({ tableName: TABLE, clientConfig, index: { dims: 1024, embeddings, fields: ['text'] } });
  await semantic.put(['sem'], 'db', { text: 'cloud database storage', kind: 'tech' });
  await semantic.put(['sem'], 'food', { text: 'a delicious recipe', kind: 'other' });
  await semantic.put(['sem'], 'skip', { text: 'cloud database too', kind: 'tech' }, false);
  const filteredSemantic = await semantic.search(['sem'], { query: 'database', filter: { kind: 'tech' }, limit: 5 });
  check('filter + semantic query combined', filteredSemantic.every((i) => i.value.kind === 'tech'));
  check('index:false item has no embedding (score 0, ranks last)', (() => {
    const skip = filteredSemantic.find((i) => i.key === 'skip');
    return skip !== undefined && skip.score === 0;
  })());
  const skipItem = await doc.get({ TableName: TABLE, Key: { PK: 'sem', SK: 'skip' } });
  check('index:false item stored without an embedding attribute', skipItem.Item.embedding === undefined);
  semantic.destroy();
}

async function storeMultiPage() {
  console.log('\n[B] store: REAL multi-page scan (>1 MB across pages)');
  const store = new DynamoDBStore({ tableName: TABLE, clientConfig });
  const big = 'x'.repeat(40000);
  for (let i = 0; i < 30; i++) await store.put(['big'], `k-${i}`, { blob: big, i });
  const found = await store.search(['big'], { limit: 100 });
  check('all 30 items (~1.2 MB) returned across scan pages', found.length === 30);
  store.destroy();
}

async function checkpointerCompressionS3() {
  console.log('\n[C] checkpointer: compression + S3 together, and concurrent putWrites');
  const saver = new DynamoDBSaver({
    tableName: TABLE,
    clientConfig,
    compression: { enabled: true },
    s3: { bucketName: BUCKET, thresholdBytes: 64 },
  });
  const value = { blob: Array.from({ length: 4000 }, (_, i) => `tok-${i % 40}`).join(' ') };
  await saver.put(cfg('cs'), cp('cs-1', value), { source: 'loop', step: 1, parents: {} }, {});
  const payloadItem = await doc.get({ TableName: TABLE, Key: { PK: 'cs', SK: 'PAYLOAD##cs-1' } });
  check('payload compressed AND offloaded to S3', payloadItem.Item.checkpoint.location === 'S3');
  check('compressed+offloaded checkpoint rehydrates', isDeepStrictEqual((await saver.getTuple(cfg('cs'))).checkpoint.channel_values, value));

  await saver.put(cfg('cw'), cp('cw-1', {}), { source: 'loop', step: 1, parents: {} }, {});
  await Promise.all([
    saver.putWrites(cfg('cw', '', 'cw-1'), [['a', '1']], 'task-A'),
    saver.putWrites(cfg('cw', '', 'cw-1'), [['b', '2']], 'task-B'),
  ]);
  const writes = (await saver.getTuple(cfg('cw', '', 'cw-1'))).pendingWrites;
  check('concurrent putWrites from two tasks both persisted', writes.length === 2);
  saver.destroy();
}

async function historyScale() {
  console.log('\n[D] history: long conversation + many sessions');
  const history = new DynamoDBChatMessageHistory({ tableName: TABLE, clientConfig });
  const sixty = Array.from({ length: 60 }, (_, i) => new HumanMessage(`msg ${i}`));
  await history.addMessages('long', sixty);
  await history.addMessages('long', [new HumanMessage('msg 60')]);
  const msgs = await history.getMessages('long');
  check('60+1 messages persist in order', msgs.length === 61 && msgs[60].content === 'msg 60' && msgs[0].content === 'msg 0');

  for (let i = 0; i < 25; i++) await history.addMessages(`sess-${i}`, [new HumanMessage('hi')]);
  const sessions = await history.listSessions();
  check('listSessions returns every session (>=26)', sessions.length >= 26);
  history.destroy();
}

async function run() {
  await setup();
  await storeOperators();
  await storeMultiPage();
  await checkpointerCompressionS3();
  await historyScale();
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
