import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { DynamoDBSaver, DynamoDBStore } from '../../src/index';
import { createTable, DDB_LOCAL_CONFIG, deleteTable } from './helpers/ddb-local';
import { MemoryS3 } from './helpers/memory-s3';
import { referencedS3Keys } from './helpers/referenced-keys';

const tableName = 'races-itest';
const admin = new DynamoDBClient(DDB_LOCAL_CONFIG);
const reader = DynamoDBDocument.from(admin);
const s3 = new MemoryS3();
/** Every payload offloads, so each write puts an object the invariants can account for. */
const offload = { bucketName: 'memory', thresholdBytes: 1, createS3Client: () => s3 };
let saver: DynamoDBSaver;
let store: DynamoDBStore;

beforeAll(async () => {
  await createTable(admin, tableName);
  saver = new DynamoDBSaver({ tableName, clientConfig: DDB_LOCAL_CONFIG, s3: offload });
  store = new DynamoDBStore({ tableName, clientConfig: DDB_LOCAL_CONFIG, s3: offload });
});

afterAll(async () => {
  saver.destroy();
  store.destroy();
  await deleteTable(admin, tableName);
  admin.destroy();
});

const metadata: CheckpointMetadata = { source: 'loop', step: 1, parents: {} };

function checkpoint(id: string, marker: string): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date(0).toISOString(),
    channel_values: { blob: `${marker}-${'x'.repeat(512)}` },
    channel_versions: { blob: 1 },
    versions_seen: {},
  };
}

const threadConfig = (threadId: string, checkpointId?: string) => ({
  configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: checkpointId },
});

/**
 * The two invariants every race must keep: no row references an object that
 * is gone (a live object was deleted), and at most `allowedOrphans` objects are
 * referenced by no row.
 */
async function expectConsistent(allowedOrphans: number): Promise<void> {
  const referenced = await referencedS3Keys(reader, tableName);
  const stored = s3.keys();
  const dangling = referenced.filter((key) => !stored.includes(key));
  expect(dangling).toEqual([]);
  const orphans = stored.filter((key) => !referenced.includes(key));
  expect(orphans.length).toBeLessThanOrEqual(allowedOrphans);
}

describe('write races against DynamoDB Local with S3 in the loop (TEST-02)', () => {
  it('two puts of the same checkpoint id both settle; the survivor is readable and no live object is lost', async () => {
    const config = threadConfig('put-put');
    await Promise.all([
      saver.put(config, checkpoint('cp-1', 'A'), metadata),
      saver.put(config, checkpoint('cp-1', 'B'), metadata),
    ]);
    const tuple = await saver.getTuple(threadConfig('put-put', 'cp-1'));
    expect(String(tuple?.checkpoint.channel_values.blob)).toMatch(/^[AB]-x/);
    /** The checkpoint transaction is unconditional, so the loser's payload can stay behind until the lifecycle rule. */
    await expectConsistent(1);
  });

  it('putWrites racing put leaves the checkpoint and every pending write readable', async () => {
    const config = threadConfig('writes-put');
    const stored = threadConfig('writes-put', 'cp-1');
    await Promise.all([
      saver.put(config, checkpoint('cp-1', 'C'), metadata),
      saver.putWrites(stored, [['messages', { text: 'w'.repeat(600) }]], 'task-1'),
      saver.putWrites(stored, [['__interrupt__', { value: 'i'.repeat(600) }]], 'task-1'),
    ]);
    const tuple = await saver.getTuple(stored);
    expect(tuple?.checkpoint.id).toBe('cp-1');
    expect(tuple?.pendingWrites?.map(([, channel]) => channel).sort()).toEqual([
      '__interrupt__',
      'messages',
    ]);
    await expectConsistent(1);
  });

  it('deleteThread racing put never strands a row or an object', async () => {
    const config = threadConfig('delete-put');
    await saver.put(config, checkpoint('cp-0', 'D0'), metadata);
    await Promise.all([
      saver.deleteThread('delete-put'),
      saver.put(threadConfig('delete-put', 'cp-0'), checkpoint('cp-1', 'D1'), metadata),
    ]);
    const tuple = await saver.getTuple(config);
    if (tuple) expect(tuple.checkpoint.id).toBe('cp-1');
    await expectConsistent(1);
  });

  it('two store puts of one key each supersede exactly one payload', async () => {
    await store.put(['race'], 'k', { v: 0, pad: 'p'.repeat(600) });
    await Promise.all([
      store.put(['race'], 'k', { v: 1, pad: 'p'.repeat(600) }),
      store.put(['race'], 'k', { v: 2, pad: 'p'.repeat(600) }),
    ]);
    const item = await store.get(['race'], 'k');
    expect([1, 2]).toContain((item?.value as { v: number }).v);
    await expectConsistent(0);
  });

  it('a store put racing a delete of the same key leaves either a readable item or nothing, never an orphan', async () => {
    await store.put(['race'], 'd', { v: 0, pad: 'p'.repeat(600) });
    await Promise.all([
      store.put(['race'], 'd', { v: 1, pad: 'p'.repeat(600) }),
      store.delete(['race'], 'd'),
    ]);
    const item = await store.get(['race'], 'd');
    if (item) expect((item.value as { v: number }).v).toBe(1);
    await expectConsistent(0);
  });
});
