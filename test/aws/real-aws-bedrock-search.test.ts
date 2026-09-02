import { randomUUID } from 'node:crypto';

import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
  waitUntilTableNotExists,
} from '@aws-sdk/client-dynamodb';
import { BedrockEmbeddings } from '@langchain/aws';

import { DynamoDBStore } from '../../src/index';

const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'eu-central-1';
const clientConfig = { region };
const tableName = `aws-langgraph-bedrocktest-${randomUUID()}`;
const EMBED_DIMS = 1024;

/**
 * Real-AWS verification of semantic search using a real Bedrock embedding
 * model (Titan Embed Text v2) with no `vectorBackend` configured, so
 * `DynamoDBStore` falls back to its in-memory cosine-ranking path. This
 * proves both the real Bedrock call and the ranking logic pick out the
 * semantically closest item, not just that the call returns a well-formed
 * response.
 */
const MODEL = 'amazon.titan-embed-text-v2:0';

/** Errors Bedrock raises when the model is not enabled for this account or region. */
const MODEL_UNAVAILABLE_ERRORS: readonly string[] = [
  'AccessDeniedException',
  'ValidationException',
  'ResourceNotFoundException',
];

describe('DynamoDBStore semantic search against real Bedrock embeddings', () => {
  let admin: DynamoDBClient;
  let store: DynamoDBStore;
  /** Set when the probe call fails for a model-availability reason; every test then skips with it. */
  let unavailable: string | undefined;

  beforeAll(async () => {
    admin = new DynamoDBClient(clientConfig);
    await admin.send(
      new CreateTableCommand({
        TableName: tableName,
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
    await waitUntilTableExists({ client: admin, maxWaitTime: 90 }, { TableName: tableName });
    const embeddings = new BedrockEmbeddings({ region, model: MODEL });
    store = new DynamoDBStore({ tableName, clientConfig, index: { dims: EMBED_DIMS, embeddings } });
    try {
      await embeddings.embedQuery('probe');
    } catch (error) {
      const { name, message } = error as Error;
      if (!MODEL_UNAVAILABLE_ERRORS.includes(name)) throw error;
      unavailable = `${name}: ${message}`;
    }
  });

  afterAll(async () => {
    store?.destroy();
    if (admin) {
      await admin.send(new DeleteTableCommand({ TableName: tableName }));
      await waitUntilTableNotExists({ client: admin, maxWaitTime: 90 }, { TableName: tableName });
      admin.destroy();
    }
  });

  it('ranks the semantically closest real-embedded item highest', async () => {
    if (unavailable !== undefined) {
      process.stderr.write(
        `skipped: Bedrock model ${MODEL} is not usable in ${region} (${unavailable})
`,
      );
      return;
    }
    await store.put(['docs'], 'cat', { text: 'The cat slept peacefully on the warm windowsill.' });
    await store.put(['docs'], 'finance', {
      text: 'Stock market indices rose sharply after the earnings report.',
    });
    await store.put(['docs'], 'dog', { text: 'The loyal dog waited by the door for its owner.' });

    const results = await store.search(['docs'], {
      query: 'a small feline curled up napping',
      limit: 3,
    });

    expect(results[0]?.key).toBe('cat');
    expect(results.map((r) => r.key).sort()).toEqual(['cat', 'dog', 'finance']);
  });
});
