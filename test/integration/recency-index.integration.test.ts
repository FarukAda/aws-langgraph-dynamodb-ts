import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { DynamoDBSaver } from '../../src/index';
import { createTable, DDB_LOCAL_CONFIG, deleteTable } from './helpers/ddb-local';

const tableName = 'recency-index-itest';
const admin = new DynamoDBClient(DDB_LOCAL_CONFIG);
let saver: DynamoDBSaver;

beforeAll(async () => {
  await createTable(admin, tableName, { recencyIndex: true });
  saver = new DynamoDBSaver({
    tableName,
    clientConfig: DDB_LOCAL_CONFIG,
    indexName: 'gsi1',
    indexShards: 1,
  });
});

afterAll(async () => {
  saver.destroy();
  await deleteTable(admin, tableName);
  admin.destroy();
});

/**
 * DynamoDB ends a Query page at 1 MB of evaluated data, whatever `Limit` says.
 * Five checkpoints carrying about 300 KB of inline metadata each cannot fit one
 * page, so a listing that does not follow `LastEvaluatedKey` returns three or
 * four of them and stops as though that were all (C-01).
 */
it('lists every checkpoint when one index shard spans several 1 MB pages', async () => {
  const blob = 'x'.repeat(300_000);
  for (let n = 0; n < 5; n++) {
    await saver.put(
      { configurable: { thread_id: `t${n}`, checkpoint_ns: '' } },
      {
        v: 4,
        id: `c${n}`,
        ts: '2026-01-01T00:00:00.000Z',
        channel_values: {},
        channel_versions: {},
        versions_seen: {},
      },
      { source: 'input', step: -1, parents: {}, blob } as CheckpointMetadata,
      {},
    );
  }
  const threads: string[] = [];
  for await (const tuple of saver.list({})) threads.push(tuple.config.configurable?.thread_id);
  expect(threads.sort()).toEqual(['t0', 't1', 't2', 't3', 't4']);
});
