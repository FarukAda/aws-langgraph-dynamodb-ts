/**
 * Populates a real DynamoDB store table with semantic-search items and LEAVES
 * it in place so it is visible in the AWS console (region eu-west-1, table
 * "langgraph-store-demo").
 *
 * Run:    node examples/live-store.mjs
 * Delete: aws dynamodb delete-table --table-name langgraph-store-demo --region eu-west-1
 */
import {
  CreateTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { BedrockEmbeddings } from '@langchain/aws';

import { DynamoDBStore } from '../dist/index.js';

const REGION = 'eu-west-1';
const TABLE = 'langgraph-store-demo';
const clientConfig = { region: REGION };
const admin = new DynamoDBClient(clientConfig);

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
  } catch (e) {
    if (e.name === 'ResourceInUseException') console.log(`Table "${TABLE}" already exists`);
    else throw e;
  }

  const embeddings = new BedrockEmbeddings({ model: 'amazon.titan-embed-text-v2:0', region: REGION });
  const store = new DynamoDBStore({
    tableName: TABLE,
    clientConfig,
    index: { dims: 1024, embeddings, fields: ['text'] },
  });

  await store.put(['library'], 'dynamo', { text: 'Amazon DynamoDB is a serverless NoSQL key-value cloud database' });
  await store.put(['library'], 'python', { text: 'Python is a popular programming language for data science' });
  await store.put(['library'], 'coffee', { text: 'Espresso is a concentrated coffee brewed under high pressure' });
  console.log('Stored 3 items under namespace ["library"] (each with a Titan embedding).');

  const results = await store.search(['library'], { query: 'managed cloud database for storage', limit: 3 });
  console.log('\nSemantic search for "managed cloud database for storage":');
  for (const r of results) console.log(`  ${r.key}  score=${r.score.toFixed(4)}`);

  store.destroy();
  admin.destroy();
  console.log(
    `\nLEFT IN PLACE. DynamoDB console -> region EU (Ireland)/${REGION} -> table "${TABLE}" -> Explore items.`,
  );
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exitCode = 1;
});
