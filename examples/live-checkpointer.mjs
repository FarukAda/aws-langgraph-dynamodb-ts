/**
 * Live demo: a real LangGraph agent backed by DynamoDBSaver against real AWS
 * DynamoDB. Creates a table, runs a graph across two separate saver instances
 * (proving state is resumed from DynamoDB, not memory), shows history,
 * time-travel, and thread deletion, then cleans up.
 *
 * Run: node examples/live-checkpointer.mjs
 */
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';

import { DynamoDBSaver } from '../dist/index.js';

const REGION = 'eu-west-1';
const TABLE = 'langgraph-saver-demo';
const clientConfig = { region: REGION };
const admin = new DynamoDBClient(clientConfig);

const log = (...a) => console.log(...a);
const section = (t) => log(`\n=== ${t} ===`);

async function ensureTable() {
  section('1. Create real DynamoDB table');
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
    log(`   created table "${TABLE}" in ${REGION}`);
  } catch (error) {
    if (error.name === 'ResourceInUseException') log(`   table "${TABLE}" already exists — reusing`);
    else throw error;
  }
}

const State = Annotation.Root({
  messages: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }),
  count: Annotation({ reducer: (_, b) => b, default: () => 0 }),
});

function buildGraph(saver) {
  return new StateGraph(State)
    .addNode('turn', (state) => ({
      messages: [`assistant: handled turn ${state.count + 1}`],
      count: state.count + 1,
    }))
    .addEdge(START, 'turn')
    .addEdge('turn', END)
    .compile({ checkpointer: saver });
}

async function run() {
  await ensureTable();
  const thread = { configurable: { thread_id: 'demo-thread' } };

  section('2. First turn (saver A) — writes a checkpoint to DynamoDB (gzip on)');
  const saverA = new DynamoDBSaver({ tableName: TABLE, clientConfig, compression: { enabled: true } });
  const r1 = await buildGraph(saverA).invoke({ messages: ['user: hello'] }, thread);
  log('   state after turn 1:', JSON.stringify(r1));
  saverA.destroy();

  section('3. Second turn (NEW saver B) — resumes prior state from DynamoDB');
  const saverB = new DynamoDBSaver({ tableName: TABLE, clientConfig, compression: { enabled: true } });
  const graphB = buildGraph(saverB);
  const r2 = await graphB.invoke({ messages: ['user: are you still there?'] }, thread);
  log('   state after turn 2:', JSON.stringify(r2));
  log(`   -> count=${r2.count} and ${r2.messages.length} messages: state survived across instances`);

  section('4. getState — current checkpoint from DynamoDB');
  const current = await graphB.getState(thread);
  log('   current count:', current.values.count);

  section('5. History — list every checkpoint (newest first)');
  const history = [];
  for await (const snap of graphB.getStateHistory(thread)) {
    history.push({ id: snap.config.configurable.checkpoint_id, count: snap.values.count });
  }
  log(`   ${history.length} checkpoints:`, JSON.stringify(history));

  section('6. Time-travel — read a specific older checkpoint by id');
  const oldest = history[history.length - 1];
  const past = await saverB.getTuple({
    configurable: { thread_id: 'demo-thread', checkpoint_id: oldest.id },
  });
  log('   oldest checkpoint count:', past?.checkpoint.channel_values.count);

  section('7. deleteThread — purge the thread');
  await saverB.deleteThread('demo-thread');
  const afterDelete = await saverB.getTuple(thread);
  log('   getTuple after delete:', afterDelete === undefined ? 'undefined (gone)' : 'STILL THERE');
  saverB.destroy();

  section('8. Cleanup — delete the table');
  await admin.send(new DeleteTableCommand({ TableName: TABLE }));
  admin.destroy();
  log('   table deleted');
  log('\nDONE — DynamoDBSaver verified end-to-end on real AWS DynamoDB.');
}

run().catch((error) => {
  console.error('\nDEMO FAILED:', error);
  process.exitCode = 1;
});
