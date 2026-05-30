/**
 * Full real-AWS acceptance run for DynamoDBChatMessageHistory: add/get,
 * multi-session isolation, auto title, lock-free concurrent appends (no lost
 * messages), per-message items under a uniform whole-conversation TTL,
 * listSessions, clear, compression, S3 offload, edge cases, AND a real
 * RunnableWithMessageHistory agent (Bedrock) that remembers across turns.
 * Asserts each, then cleans up.
 *
 * Run: node examples/verify-history.mjs
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
import { ChatBedrockConverse } from '@langchain/aws';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { RunnableWithMessageHistory } from '@langchain/core/runnables';

import { DynamoDBChatMessageHistory } from '../dist/index.js';

const REGION = 'eu-west-1';
const TABLE = 'langgraph-verify-history';
const BUCKET = 'langgraph-verify-history-712098997573-euw1';
const MODEL = 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
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

async function run() {
  await setup();
  const history = new DynamoDBChatMessageHistory({ tableName: TABLE, clientConfig });

  console.log('\n[A] add / get / order / title');
  await history.addMessages('chat-1', [new HumanMessage('What is DynamoDB?'), new AIMessage('A NoSQL database.')]);
  await history.addMessage('chat-1', new HumanMessage('Is it serverless?'));
  let msgs = await history.getMessages('chat-1');
  check('messages persist in order', msgs.map((m) => m.content).join('|') === 'What is DynamoDB?|A NoSQL database.|Is it serverless?');
  check('types preserved', msgs[0].getType() === 'human' && msgs[1].getType() === 'ai');

  console.log('\n[B] multi-session isolation + listSessions + title');
  await history.addMessages('chat-2', [new HumanMessage('Different conversation')]);
  check('session chat-2 is isolated', (await history.getMessages('chat-2')).length === 1);
  const sessions = await history.listSessions();
  check('listSessions returns both sessions', sessions.map((s) => s.sessionId).sort().join(',') === 'chat-1,chat-2');
  const chat1 = sessions.find((s) => s.sessionId === 'chat-1');
  check('auto title from first human message', chat1.title === 'What is DynamoDB?');
  check('message count tracked', chat1.messageCount === 3);

  console.log('\n[C] per-message items + one SESSION metadata item (uniform TTL, no gaps)');
  const scan = await doc.scan({ TableName: TABLE, FilterExpression: 'PK = :p', ExpressionAttributeValues: { ':p': 'chat-1' } });
  const msgItems = scan.Items.filter((i) => i.SK.startsWith('MSG#'));
  const sessionItems = scan.Items.filter((i) => i.SK === 'SESSION');
  check('3 message items + 1 SESSION metadata item', msgItems.length === 3 && sessionItems.length === 1);
  check('message items have distinct MSG# sort keys', new Set(msgItems.map((i) => i.SK)).size === 3);

  console.log('\n[D] lock-free concurrency: concurrent appends do not lose messages');
  await Promise.all([
    history.addMessages('race', [new HumanMessage('A')]),
    history.addMessages('race', [new HumanMessage('B')]),
    history.addMessages('race', [new HumanMessage('C')]),
  ]);
  const raceMsgs = await history.getMessages('race');
  check('all 3 concurrent messages survived', raceMsgs.length === 3);
  check('contents all present', ['A', 'B', 'C'].every((c) => raceMsgs.some((m) => m.content === c)));

  console.log('\n[E] clear');
  await history.clear('chat-2');
  check('cleared session is empty', (await history.getMessages('chat-2')).length === 0);

  console.log('\n[F] TTL attribute');
  const tHistory = new DynamoDBChatMessageHistory({ tableName: TABLE, clientConfig, ttl: { seconds: 3600 } });
  await tHistory.addMessages('ttl-chat', [new HumanMessage('hi')]);
  const ttlItem = await doc.get({ TableName: TABLE, Key: { PK: 'ttl-chat', SK: 'SESSION' } });
  check('ttl ~now+3600', Math.abs(ttlItem.Item.ttl - (Math.floor(Date.now() / 1000) + 3600)) < 120);
  tHistory.destroy();

  console.log('\n[G] per-message compression + S3 offload of a large message');
  const msgQuery = (pk) =>
    doc.query({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :p AND begins_with(SK, :m)',
      ExpressionAttributeValues: { ':p': pk, ':m': 'MSG#' },
    });

  const cHistory = new DynamoDBChatMessageHistory({ tableName: TABLE, clientConfig, compression: { enabled: true } });
  await cHistory.addMessages('big', [new HumanMessage('x'.repeat(40000))]);
  const cMsg = (await msgQuery('big')).Items[0];
  check('large message compressed inline', cMsg.message.location === 'INLINE' && cMsg.message.bytes.length < 5000);
  cHistory.destroy();

  const oHistory = new DynamoDBChatMessageHistory({ tableName: TABLE, clientConfig, s3: { bucketName: BUCKET, thresholdBytes: 1024 } });
  await oHistory.addMessages('off', [new HumanMessage('y'.repeat(60000))]);
  const oMsg = (await msgQuery('off')).Items[0];
  check('huge message offloaded to S3', oMsg.message.location === 'S3');
  let exists = false;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: oMsg.message.s3Key }));
    exists = true;
  } catch {
    exists = false;
  }
  check('offloaded message object exists in S3', exists);
  check('offloaded history rehydrates', (await oHistory.getMessages('off'))[0].content.length === 60000);
  await oHistory.clear('off');
  let gone = false;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: oMsg.message.s3Key }));
  } catch (e) {
    gone = e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
  }
  check('clear removed the offloaded S3 object', gone);
  oHistory.destroy();

  console.log('\n[H] edge cases');
  check('getMessages unknown session -> []', (await history.getMessages('nope')).length === 0);
  await history.clear('also-nope');
  check('clear unknown session does not throw', true);
  await history.addMessages('chat-1', []);
  check('empty addMessages is a no-op', (await history.getMessages('chat-1')).length === 3);
  await expectThrow('empty sessionId -> VALIDATION', () => history.addMessages('', [new HumanMessage('x')]), 'VALIDATION');

  console.log('\n[I] REAL agent: RunnableWithMessageHistory remembers across turns');
  const llm = new ChatBedrockConverse({ model: MODEL, region: REGION, temperature: 0 });
  const prompt = ChatPromptTemplate.fromMessages([
    ['system', 'You are concise. Answer in one short sentence.'],
    new MessagesPlaceholder('history'),
    ['human', '{input}'],
  ]);
  const withHistory = new RunnableWithMessageHistory({
    runnable: prompt.pipe(llm),
    getMessageHistory: (sessionId) => history.forSession(sessionId),
    inputMessagesKey: 'input',
    historyMessagesKey: 'history',
  });
  const cfg = { configurable: { sessionId: 'agent-chat' } };
  await withHistory.invoke({ input: 'My name is Faruk and I love DynamoDB.' }, cfg);
  const reply = await withHistory.invoke({ input: 'What is my name and what do I love?' }, cfg);
  const text = String(reply.content);
  console.log(`  agent replied: ${text}`);
  check('agent recalled the name from DynamoDB history', /faruk/i.test(text));
  check('agent recalled the topic from DynamoDB history', /dynamodb/i.test(text));

  history.destroy();
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
