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
import { liveRegion } from './helpers/env';

const region = liveRegion();
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

/**
 * Whether a model this account has not enabled fails the suite instead of
 * skipping it. Enabling a Bedrock model is an account setting, not something
 * this repository can make true, so a skip is the default; a maintainer who
 * has enabled it sets `AWS_TEST_REQUIRE_BEDROCK=1` — the live workflow passes
 * the repository variable of that name through — and from then on a model
 * that stops being usable fails the release gate rather than quietly passing
 * it with the one semantic-search check against a real model never run.
 */
const REQUIRED = process.env.AWS_TEST_REQUIRE_BEDROCK === '1';

/**
 * Say so where it is read: a skip inside a passing test is invisible in a
 * run's summary, so on a runner it is also raised as a workflow annotation.
 */
function reportSkip(reason: string): void {
  const line = `skipped: Bedrock model ${MODEL} is not usable in ${region} (${reason})`;
  process.stderr.write(`${line}\n`);
  if (process.env.GITHUB_ACTIONS === 'true') {
    process.stdout.write(`::warning title=Bedrock semantic-search check skipped::${line}\n`);
  }
}

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
      if (REQUIRED) {
        throw new Error(
          `Bedrock model ${MODEL} is not usable in ${region} (${name}: ${message}), and ` +
            'AWS_TEST_REQUIRE_BEDROCK=1 requires it; enable the model or unset the flag.',
          { cause: error },
        );
      }
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
      reportSkip(unavailable);
      return;
    }
    // The expected winner is written last and sorts last by key, so neither
    // insertion order nor an unranked read's key order could put it first.
    await store.put(['docs'], 'a-dog', { text: 'The loyal dog waited by the door for its owner.' });
    await store.put(['docs'], 'b-finance', {
      text: 'Stock market indices rose sharply after the earnings report.',
    });
    await store.put(['docs'], 'z-cat', {
      text: 'The cat slept peacefully on the warm windowsill.',
    });

    const results = await store.search(['docs'], {
      query: 'a small feline curled up napping',
      limit: 3,
    });

    expect(results[0]?.key).toBe('z-cat');
    expect(results.map((r) => r.key).sort()).toEqual(['a-dog', 'b-finance', 'z-cat']);
  });
});
