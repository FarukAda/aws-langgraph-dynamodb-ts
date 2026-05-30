/**
 * Real LLM agent whose ONLY memory is DynamoDBSaver. Session 1 tells the agent
 * a fact; session 2 uses a BRAND-NEW agent + NEW saver (no shared memory) and
 * asks it to recall — so a correct answer can only come from DynamoDB.
 *
 * Run: node examples/live-agent.mjs
 * Delete table: aws dynamodb delete-table --table-name langgraph-saver-demo --region eu-west-1
 */
import {
  CreateTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { ChatBedrockConverse } from '@langchain/aws';
import { createReactAgent } from '@langchain/langgraph/prebuilt';

import { DynamoDBSaver } from '../dist/index.js';

const REGION = 'eu-west-1';
const TABLE = 'langgraph-saver-demo';
const MODEL = 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
const THREAD = { configurable: { thread_id: 'agent-memory-demo' } };
const clientConfig = { region: REGION };
const admin = new DynamoDBClient(clientConfig);

const SYSTEM = 'You are a concise assistant. Answer in one short sentence.';

async function ensureTable() {
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
  } catch (error) {
    if (error.name !== 'ResourceInUseException') throw error;
  }
}

function newAgent() {
  const saver = new DynamoDBSaver({ tableName: TABLE, clientConfig, compression: { enabled: true } });
  const llm = new ChatBedrockConverse({ model: MODEL, region: REGION, temperature: 0 });
  return { saver, agent: createReactAgent({ llm, tools: [], stateModifier: SYSTEM, checkpointer: saver }) };
}

async function ask(agent, text) {
  const out = await agent.invoke({ messages: [{ role: 'user', content: text }] }, THREAD);
  return out.messages[out.messages.length - 1].content;
}

async function main() {
  await ensureTable();
  console.log(`Table "${TABLE}" ready in ${REGION}. Thread: ${THREAD.configurable.thread_id}\n`);

  console.log('--- SESSION 1 (agent A + saver A) ---');
  const s1 = newAgent();
  console.log('USER : My name is Faruk and my favorite database is DynamoDB. Please remember that.');
  console.log('AGENT:', await ask(s1.agent, 'My name is Faruk and my favorite database is DynamoDB. Please remember that.'));
  s1.saver.destroy();
  console.log('(session 1 ended — agent A and saver A destroyed; memory now lives ONLY in DynamoDB)\n');

  console.log('--- SESSION 2 (NEW agent B + NEW saver B, same thread) ---');
  const s2 = newAgent();
  console.log('USER : What is my name, and what is my favorite database?');
  console.log('AGENT:', await ask(s2.agent, 'What is my name, and what is my favorite database?'));
  s2.saver.destroy();

  admin.destroy();
  console.log('\nThe agent recalled facts from session 1 — recovered from DynamoDB by the new instance.');
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exitCode = 1;
});
