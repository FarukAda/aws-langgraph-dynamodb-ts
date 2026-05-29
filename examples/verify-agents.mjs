/**
 * Real-agent acceptance run against real AWS + real Bedrock:
 *   1. Checkpointer inside a LangGraph graph: interrupt -> resume ->
 *      getStateHistory (time-travel) -> updateState (fork).
 *   2. DynamoDBStore as an agent's cross-thread long-term memory: a tool-using
 *      Bedrock agent saves a fact in one run and semantically recalls it in a
 *      later run with NO conversation memory (only the store carries it).
 *   3. DynamoDBFactory: one agent using saver (checkpointer) + store (memory
 *      tool) together from a single shared client.
 *
 * Run: node examples/verify-agents.mjs
 */
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { ChatBedrockConverse, BedrockEmbeddings } from '@langchain/aws';
import { tool } from '@langchain/core/tools';
import { Annotation, Command, END, interrupt, START, StateGraph } from '@langchain/langgraph';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';

import { DynamoDBFactory, DynamoDBSaver, DynamoDBStore } from '../dist/index.js';

const REGION = 'eu-west-1';
const TABLE = 'langgraph-verify-agents';
const MODEL = 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
const clientConfig = { region: REGION };
const admin = new DynamoDBClient(clientConfig);

let passed = 0;
let failed = 0;
const check = (label, ok) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  ok ? (passed += 1) : (failed += 1);
};

const llm = () => new ChatBedrockConverse({ model: MODEL, region: REGION, temperature: 0 });
const embeddings = () => new BedrockEmbeddings({ model: 'amazon.titan-embed-text-v2:0', region: REGION });

function memoryTools(store, namespace) {
  let counter = 0;
  const save = tool(
    async ({ content }) => {
      counter += 1;
      await store.put(namespace, `m-${counter}`, { content });
      return 'saved';
    },
    { name: 'save_memory', description: 'Save a fact to long-term memory.', schema: z.object({ content: z.string() }) },
  );
  const search = tool(
    async ({ query }) => {
      const hits = await store.search(namespace, { query, limit: 3 });
      return hits.map((h) => h.value.content).join('; ') || 'no memories found';
    },
    { name: 'search_memory', description: 'Search long-term memory for relevant facts.', schema: z.object({ query: z.string() }) },
  );
  return [save, search];
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
}

async function checkpointerInGraph() {
  console.log('\n[1] checkpointer in a LangGraph graph: interrupt / resume / time-travel');
  const saver = new DynamoDBSaver({ tableName: TABLE, clientConfig });
  const State = Annotation.Root({
    steps: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }),
  });
  const graph = new StateGraph(State)
    .addNode('ask', () => ({ steps: [`got:${interrupt('need input')}`] }))
    .addNode('done', () => ({ steps: ['done'] }))
    .addEdge(START, 'ask')
    .addEdge('ask', 'done')
    .addEdge('done', END)
    .compile({ checkpointer: saver });

  const thread = { configurable: { thread_id: 'graph-1' } };
  await graph.invoke({ steps: ['start'] }, thread);
  const paused = await graph.getState(thread);
  check('graph paused at interrupt (persisted to DynamoDB)', paused.next.includes('ask'));

  const resumed = await graph.invoke(new Command({ resume: 'March-15' }), thread);
  check('resumed from DynamoDB after interrupt', resumed.steps.includes('got:March-15') && resumed.steps.includes('done'));

  const hist = [];
  for await (const snap of graph.getStateHistory(thread)) hist.push(snap);
  check('getStateHistory returns the full checkpoint trail', hist.length >= 3);

  const oldest = hist[hist.length - 1];
  const forkedConfig = await graph.updateState(oldest.config, { steps: ['forked'] });
  const forked = await graph.getState(forkedConfig);
  check('updateState forks a new checkpoint (time-travel)', forked.values.steps.includes('forked'));

  saver.destroy();
}

async function storeAsAgentMemory() {
  console.log('\n[2] DynamoDBStore as cross-thread agent memory (real Bedrock)');
  const store = new DynamoDBStore({ tableName: TABLE, clientConfig, index: { dims: 1024, embeddings: embeddings() } });
  const namespace = ['memories', 'user-1'];

  const writer = createReactAgent({ llm: llm(), tools: memoryTools(store, namespace) });
  await writer.invoke({ messages: [{ role: 'user', content: 'Please save to memory: my project deadline is March 15, 2026.' }] });

  // A fresh agent with NO conversation history — recall can only come from the store.
  const reader = createReactAgent({ llm: llm(), tools: memoryTools(store, namespace) });
  const res = await reader.invoke({
    messages: [{ role: 'user', content: 'Search your long-term memory: when is my project deadline?' }],
  });
  const text = String(res.messages[res.messages.length - 1].content);
  console.log(`  agent replied: ${text.slice(0, 120)}`);
  check('agent recalled the stored memory across separate runs', /march 15/i.test(text));
  store.destroy();
}

async function factoryCombinedAgent() {
  console.log('\n[3] DynamoDBFactory: one agent using saver (checkpointer) + store (memory)');
  const factory = new DynamoDBFactory({ clientConfig });
  const { saver, store, history, destroy } = factory.createAll({
    saver: { tableName: TABLE },
    store: { tableName: TABLE, index: { dims: 1024, embeddings: embeddings() } },
    history: { tableName: TABLE },
  });
  const agent = createReactAgent({
    llm: llm(),
    tools: memoryTools(store, ['memories', 'combo']),
    checkpointer: saver,
  });
  const thread = { configurable: { thread_id: 'combo-thread' } };
  await agent.invoke(
    { messages: [{ role: 'user', content: 'Save to memory that my favorite database is DynamoDB.' }] },
    thread,
  );
  check('saver checkpointed the agent run', (await saver.getTuple(thread)) !== undefined);
  const recalled = await store.search(['memories', 'combo'], { query: 'favorite database', limit: 1 });
  check('store retained the agent memory', recalled.length === 1 && /dynamodb/i.test(recalled[0].value.content));
  check('history adapter is wired via factory', typeof history.addMessages === 'function');
  destroy();
}

async function run() {
  await setup();
  await checkpointerInGraph();
  await storeAsAgentMemory();
  await factoryCombinedAgent();
  await admin.send(new DeleteTableCommand({ TableName: TABLE }));
  admin.destroy();
  console.log(`\n==== ${passed} passed, ${failed} failed ====`);
  if (failed > 0) process.exitCode = 1;
}

run().catch(async (e) => {
  console.error('\nVERIFY CRASHED:', e);
  try {
    await admin.send(new DeleteTableCommand({ TableName: TABLE }));
    admin.destroy();
  } catch {
    /* best effort */
  }
  process.exitCode = 1;
});
