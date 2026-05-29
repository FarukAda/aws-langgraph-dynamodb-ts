/**
 * Full real-AWS acceptance run for DynamoDBStore: get/put/delete, namespace
 * isolation, metadata filters, REAL semantic search (Bedrock Titan embeddings),
 * listNamespaces, compression, S3 offload, TTL, and edge cases — each asserted
 * against real DynamoDB + S3. Creates and tears down all resources.
 *
 * Run: node examples/verify-store.mjs
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
import { BedrockEmbeddings } from '@langchain/aws';
import { isDeepStrictEqual } from 'node:util';

import { DynamoDBStore } from '../dist/index.js';

const REGION = 'eu-west-1';
const TABLE = 'langgraph-verify-store';
const BUCKET = 'langgraph-verify-store-712098997573-euw1';
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
async function expectThrow(label, fn, code) {
  try {
    await fn();
    check(label, false);
  } catch (e) {
    check(label, e.code === code || e.name === code);
  }
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
      new CreateBucketCommand({
        Bucket: BUCKET,
        CreateBucketConfiguration: { LocationConstraint: REGION },
      }),
    );
  } catch (e) {
    if (e.name !== 'BucketAlreadyOwnedByYou' && e.name !== 'BucketAlreadyExists') throw e;
  }
}

async function emptyBucket() {
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
    /* bucket might not exist */
  }
}

async function teardown() {
  await admin.send(new DeleteTableCommand({ TableName: TABLE }));
  await emptyBucket();
  admin.destroy();
  s3.destroy();
}

async function run() {
  await setup();
  const store = new DynamoDBStore({ tableName: TABLE, clientConfig });

  console.log('\n[A] put / get / update / delete');
  await store.put(['users', 'u1'], 'profile', { name: 'Faruk', score: 10 });
  let item = await store.get(['users', 'u1'], 'profile');
  check('get returns the stored value', isDeepStrictEqual(item.value, { name: 'Faruk', score: 10 }));
  check('item carries namespace + key', isDeepStrictEqual(item.namespace, ['users', 'u1']) && item.key === 'profile');
  check('createdAt/updatedAt are Dates', item.createdAt instanceof Date && item.updatedAt instanceof Date);
  const created = item.createdAt.toISOString();
  await store.put(['users', 'u1'], 'profile', { name: 'Faruk', score: 11 });
  item = await store.get(['users', 'u1'], 'profile');
  check('update changes value', item.value.score === 11);
  check('update preserves createdAt', item.createdAt.toISOString() === created);
  await store.delete(['users', 'u1'], 'profile');
  check('delete removes the item', (await store.get(['users', 'u1'], 'profile')) === null);

  console.log('\n[B] namespace isolation + metadata filters');
  await store.put(['docs', 'team'], 'a', { type: 'report', score: 3 });
  await store.put(['docs', 'team'], 'b', { type: 'report', score: 9 });
  await store.put(['other'], 'c', { type: 'report', score: 100 });
  const inDocs = await store.search(['docs']);
  check('search is scoped to the namespace prefix', inDocs.map((i) => i.key).sort().join(',') === 'a,b');
  const highScore = await store.search(['docs'], { filter: { score: { $gte: 5 } } });
  check('filter with $gte operator', highScore.map((i) => i.key).join(',') === 'b');
  const exact = await store.search(['docs'], { filter: { type: 'report', score: 3 } });
  check('filter with exact match', exact.map((i) => i.key).join(',') === 'a');
  check('limit/offset paginate', (await store.search(['docs'], { limit: 1, offset: 1 })).length === 1);

  console.log('\n[C] listNamespaces');
  const namespaces = await store.listNamespaces();
  check('lists distinct namespaces', namespaces.some((n) => isDeepStrictEqual(n, ['docs', 'team'])));
  const depth1 = await store.listNamespaces({ maxDepth: 1 });
  check('maxDepth truncates + dedupes', depth1.some((n) => isDeepStrictEqual(n, ['docs'])));

  console.log('\n[D] REAL semantic search (Bedrock Titan embeddings)');
  const embeddings = new BedrockEmbeddings({ model: 'amazon.titan-embed-text-v2:0', region: REGION });
  const semantic = new DynamoDBStore({ tableName: TABLE, clientConfig, index: { dims: 1024, embeddings, fields: ['text'] } });
  await semantic.put(['library'], 'dynamo', { text: 'Amazon DynamoDB is a serverless NoSQL key-value cloud database' });
  await semantic.put(['library'], 'python', { text: 'Python is a popular programming language for data science' });
  await semantic.put(['library'], 'coffee', { text: 'Espresso is a concentrated coffee brewed under high pressure' });
  const ranked = await semantic.search(['library'], { query: 'managed cloud database for storage', limit: 3 });
  check('semantic search returns scored results', ranked.every((r) => typeof r.score === 'number'));
  check('most relevant document ranks first (dynamo)', ranked[0].key === 'dynamo');
  check('least relevant ranks last (coffee)', ranked[ranked.length - 1].key === 'coffee');

  console.log('\n[E] compression (large value round-trips)');
  const csaver = new DynamoDBStore({ tableName: TABLE, clientConfig, compression: { enabled: true } });
  const bigValue = { blob: 'x'.repeat(40000) };
  await csaver.put(['big'], 'c1', bigValue);
  const cItem = await doc.get({ TableName: TABLE, Key: { PK: 'big', SK: 'c1' } });
  check('compressed value stored inline + small', cItem.Item.value.location === 'INLINE' && cItem.Item.value.bytes.length < 5000);
  check('compressed value round-trips', isDeepStrictEqual((await csaver.get(['big'], 'c1')).value, bigValue));

  console.log('\n[F] S3 offload (real bucket) + rehydrate');
  const osaver = new DynamoDBStore({ tableName: TABLE, clientConfig, s3: { bucketName: BUCKET, thresholdBytes: 1024 } });
  const offloadValue = { blob: 'y'.repeat(50000) };
  await osaver.put(['off'], 'o1', offloadValue);
  const oItem = await doc.get({ TableName: TABLE, Key: { PK: 'off', SK: 'o1' } });
  check('large value offloaded to S3', oItem.Item.value.location === 'S3');
  let exists = false;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: oItem.Item.value.s3Key }));
    exists = true;
  } catch {
    exists = false;
  }
  check('offloaded object exists in S3', exists);
  check('value rehydrates from S3', isDeepStrictEqual((await osaver.get(['off'], 'o1')).value, offloadValue));
  osaver.destroy();

  console.log('\n[G] TTL attribute');
  const tsaver = new DynamoDBStore({ tableName: TABLE, clientConfig, ttl: { seconds: 3600 } });
  await tsaver.put(['ttl'], 't1', { x: 1 });
  const ttlItem = await doc.get({ TableName: TABLE, Key: { PK: 'ttl', SK: 't1' } });
  check('ttl attribute ~now+3600', Math.abs(ttlItem.Item.ttl - (Math.floor(Date.now() / 1000) + 3600)) < 120);

  console.log('\n[H] special values + edge cases');
  const tricky = { text: 'héllo 🌍', nested: { a: [1, null, { b: 2 }] }, empty: '' };
  await store.put(['sp'], 's1', tricky);
  check('unicode/nested/null round-trips', isDeepStrictEqual((await store.get(['sp'], 's1')).value, tricky));
  check('get missing -> null', (await store.get(['nope'], 'x')) === null);
  await store.delete(['nope'], 'gone');
  check('delete missing does not throw', true);
  check('search no matches -> empty', (await store.search(['no-such-ns'])).length === 0);
  await expectThrow('invalid namespace (separator) -> VALIDATION', () => store.put(['a#b'], 'k', { v: 1 }), 'VALIDATION');

  store.destroy();
  semantic.destroy();
  csaver.destroy();
  tsaver.destroy();
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
