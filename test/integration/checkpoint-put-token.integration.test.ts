// Proves against a real DynamoDB what a hand-rolled double can only model:
// the checkpoint transaction's own idempotency. It is sent once, under one
// token, and re-sent unchanged for every attempt of the budget, so the service
// answers a retry that follows a lost acknowledgement from its idempotency
// cache instead of applying the META/PAYLOAD pair a second time.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { DynamoDBSaver } from '../../src/index';
import { SILENT_LOGGER } from '../../src/shared/logging/logger';
import { createTable, DDB_LOCAL_CONFIG, deleteTable } from './helpers/ddb-local';
import { afterResponse, dropResponses } from './helpers/fault-injection';
import { MemoryS3 } from './helpers/memory-s3';

const tableName = 'checkpoint-put-token-itest';
const admin = new DynamoDBClient(DDB_LOCAL_CONFIG);
/** Shared by every saver here, so one saver's cleanup is visible to the others. */
const s3 = new MemoryS3();
let client: DynamoDBDocument;
let saver: DynamoDBSaver;

/** `thresholdBytes: 1` offloads both rows' payloads, which is the case at stake. */
const s3Options = { bucketName: 'memory', thresholdBytes: 1, createS3Client: () => s3 };

const metadata: CheckpointMetadata = { source: 'loop', step: 1, parents: {} };

function checkpoint(id: string): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date(0).toISOString(),
    channel_values: { messages: ['hello'] },
    channel_versions: { messages: 1 },
    versions_seen: {},
  };
}

/** A saver whose writes go through `base`, so a fault rule installed on it fires. */
function saverOn(base: DynamoDBClient): DynamoDBSaver {
  return new DynamoDBSaver({
    tableName,
    client: DynamoDBDocument.from(base),
    logger: SILENT_LOGGER,
    s3: s3Options,
  });
}

/** The sort keys the thread's partition holds, read consistently. */
async function sortKeys(threadId: string): Promise<string[]> {
  const page = await client.query({
    TableName: tableName,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `CHKPT#${threadId}` },
    ConsistentRead: true,
  });
  return (page.Items ?? []).map((item) => String(item.SK)).sort();
}

beforeAll(async () => {
  await createTable(admin, tableName);
  client = DynamoDBDocument.from(new DynamoDBClient(DDB_LOCAL_CONFIG));
  saver = new DynamoDBSaver({
    tableName,
    clientConfig: DDB_LOCAL_CONFIG,
    logger: SILENT_LOGGER,
    s3: s3Options,
  });
});

afterAll(async () => {
  saver.destroy();
  await deleteTable(admin, tableName);
  admin.destroy();
});

describe('the checkpoint pair under its own request token', () => {
  it('leaves one META/PAYLOAD pair, naming objects that are all still there, when the acknowledgement is lost', async () => {
    const threadId = 'lost-ack';
    const base = new DynamoDBClient({ ...DDB_LOCAL_CONFIG, maxAttempts: 1 });
    dropResponses(base, 'TransactWriteItemsCommand', 1);
    const faulted = saverOn(base);

    const stored = await faulted.put(
      { configurable: { thread_id: threadId, checkpoint_ns: '' } },
      checkpoint('c1'),
      metadata,
    );
    faulted.destroy();
    base.destroy();

    expect(stored.configurable?.checkpoint_id).toBe('c1');
    expect(await sortKeys(threadId)).toEqual(['META##c1', 'PAYLOAD##c1']);
    /**
     * No missing object: the rows read back through the offloader, which
     * fetches every key they name and fails loudly on one that is gone.
     */
    const tuple = await saver.getTuple({
      configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: 'c1' },
    });
    expect(tuple?.checkpoint.channel_values).toEqual({ messages: ['hello'] });
    expect(tuple?.metadata).toEqual(metadata);
  });

  /**
   * The composition, not the service fact: `saver.put` itself, a transaction
   * that commits and whose acknowledgement is then lost, a concurrent
   * `deleteThread` that removes both rows and releases the objects they name,
   * and the library's own retry re-sending the identical tokened request. The
   * rows must stay deleted.
   *
   * Without the token the retry is a brand-new unconditional transaction -
   * there is no guard on either row to turn it away - so it puts both rows
   * back, live and naming two objects the deletion has already released, which
   * no later read can recover from.
   */
  it('does not put back the pair a concurrent deleteThread removed while the put was in flight', async () => {
    const threadId = 'reland';
    const base = new DynamoDBClient({ ...DDB_LOCAL_CONFIG, maxAttempts: 1 });
    afterResponse(base, 'TransactWriteItemsCommand', async () => {
      await saver.deleteThread(threadId);
      throw Object.assign(new Error('simulated lost response'), { name: 'TimeoutError' });
    });
    const faulted = saverOn(base);

    await faulted.put(
      { configurable: { thread_id: threadId, checkpoint_ns: '' } },
      checkpoint('c1'),
      metadata,
    );
    faulted.destroy();
    base.destroy();

    expect(await sortKeys(threadId)).toEqual([]);
  });
});
