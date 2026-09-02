/**
 * Like live-checkpointer.mjs but LEAVES the table in place so it is visible in
 * the AWS console (region eu-west-1, table "langgraph-saver-demo").
 *
 * Run:    node examples/live-persist.mjs
 * Delete: aws dynamodb delete-table --table-name langgraph-saver-demo --region eu-west-1
 */
import {
  CreateTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';

import { DynamoDBSaver } from '../dist/index.js';

const REGION = process.env.AWS_REGION ?? 'eu-west-1';
const TABLE = process.env.LANGGRAPH_DEMO_TABLE ?? 'langgraph-saver-demo';
const clientConfig = { region: REGION };
const admin = new DynamoDBClient(clientConfig);

const State = Annotation.Root({
  messages: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }),
  count: Annotation({ reducer: (_, b) => b, default: () => 0 }),
});

async function main() {
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
    console.log(`Created table "${TABLE}" in ${REGION}`);
  } catch (error) {
    if (error.name === 'ResourceInUseException') console.log(`Table "${TABLE}" already exists`);
    else throw error;
  }

  const saver = new DynamoDBSaver({ tableName: TABLE, clientConfig });
  const graph = new StateGraph(State)
    .addNode('turn', (s) => ({ messages: [`assistant: turn ${s.count + 1}`], count: s.count + 1 }))
    .addEdge(START, 'turn')
    .addEdge('turn', END)
    .compile({ checkpointer: saver });

  const thread = { configurable: { thread_id: 'demo-thread' } };
  await graph.invoke({ messages: ['user: hello'] }, thread);
  await graph.invoke({ messages: ['user: again'] }, thread);
  const state = await graph.getState(thread);
  console.log('Final persisted state:', JSON.stringify(state.values));
  saver.destroy();
  admin.destroy();
  console.log(
    `\nLEFT IN PLACE. Open the DynamoDB console, switch region to EU (Ireland) / ${REGION}, ` +
      `open table "${TABLE}" -> Explore items.`,
  );
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exitCode = 1;
});
