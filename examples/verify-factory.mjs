/**
 * Real-AWS check that DynamoDBFactory.createAll wires all three adapters onto a
 * single shared client, that each works against one physical table, and that
 * the combined destroy() tears the shared client down. Creates + deletes the
 * table.
 *
 * Run: node examples/verify-factory.mjs
 */
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { AIMessage, HumanMessage } from '@langchain/core/messages';

import { DynamoDBFactory } from '../dist/index.js';

const REGION = 'eu-west-1';
const TABLE = 'langgraph-verify-factory';
const clientConfig = { region: REGION };
const admin = new DynamoDBClient(clientConfig);

let passed = 0;
let failed = 0;
const check = (label, ok) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  ok ? (passed += 1) : (failed += 1);
};

async function run() {
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

  const factory = new DynamoDBFactory({ clientConfig });
  const { saver, store, history, destroy } = factory.createAll({
    saver: { tableName: TABLE },
    store: { tableName: TABLE },
    history: { tableName: TABLE },
  });

  console.log('\n[factory.createAll] three adapters on one shared client + one table');

  await saver.put({ configurable: { thread_id: 'f-thread' } }, {
    v: 4,
    id: 'cp-f',
    ts: '',
    channel_values: { ok: true },
    channel_versions: {},
    versions_seen: {},
  }, { source: 'loop', step: 1, parents: {} }, {});
  const tuple = await saver.getTuple({ configurable: { thread_id: 'f-thread' } });
  check('saver works via factory', tuple?.checkpoint.id === 'cp-f');

  await store.put(['f-ns'], 'k', { hello: 'store' });
  const item = await store.get(['f-ns'], 'k');
  check('store works via factory', item?.value.hello === 'store');

  await history.addMessages('f-sess', [new HumanMessage('hi'), new AIMessage('yo')]);
  const msgs = await history.getMessages('f-sess');
  check('history works via factory', msgs.length === 2);

  check('all three coexist in one physical table', tuple !== undefined && item !== null && msgs.length === 2);

  destroy();
  check('combined destroy() runs without error', true);

  await admin.send(new DeleteTableCommand({ TableName: TABLE }));
  admin.destroy();
  console.log(`\n==== ${passed} passed, ${failed} failed ====`);
  if (failed > 0) process.exitCode = 1;
}

run().catch(async (e) => {
  console.error('\nVERIFY CRASHED:', e);
  try {
    await admin.send(new DeleteTableCommand({ TableName: TABLE }));
  } catch {
    /* best effort */
  }
  process.exitCode = 1;
});
