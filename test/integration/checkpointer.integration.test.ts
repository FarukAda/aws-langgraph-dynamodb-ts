/**
 * End-to-end checkpointer tests against DynamoDB Local.
 *
 * These exercise the real DDB API — covering behaviour that aws-sdk-client-mock
 * cannot faithfully simulate: ConditionExpression enforcement, TransactWrite
 * atomicity, ConsistentRead semantics under concurrent writes, Query
 * pagination, and the real item shape our code writes.
 */

import { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { DynamoDBSaver } from '../../src/checkpointer';
import {
  assertDdbLocalReachable,
  createAllTables,
  dropAllTables,
  makeLocalClient,
  uniquePrefix,
} from './helpers/ddb-local';

const prefix = uniquePrefix('saver');
const { ddb, doc } = makeLocalClient();

let tables: Awaited<ReturnType<typeof createAllTables>>;
let saver: DynamoDBSaver;

beforeAll(async () => {
  await assertDdbLocalReachable(ddb);
  tables = await createAllTables(ddb, prefix);
  saver = new DynamoDBSaver({
    checkpointsTableName: tables.checkpointsTable,
    writesTableName: tables.writesTable,
    client: doc,
  });
});

afterAll(async () => {
  saver.destroy();
  await dropAllTables(ddb, tables);
  ddb.destroy();
});

function mkCheckpoint(id: string): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date().toISOString(),
    channel_values: { greeting: 'hello' },
    channel_versions: { greeting: 1 },
    versions_seen: {},
  };
}

function mkMetadata(): CheckpointMetadata {
  return { source: 'input', step: 0, parents: {} };
}

describe('DynamoDBSaver against DynamoDB Local', () => {
  it('round-trips a checkpoint via put → getTuple with strong consistency', async () => {
    const config = { configurable: { thread_id: 'thread-roundtrip' } };
    const checkpoint = mkCheckpoint('ckpt-1');
    const metadata = mkMetadata();

    const saveResult = await saver.put(config, checkpoint, metadata, {});
    expect(saveResult.configurable?.checkpoint_id).toBe('ckpt-1');

    const tuple = await saver.getTuple({
      configurable: {
        thread_id: 'thread-roundtrip',
        checkpoint_id: 'ckpt-1',
      },
    });

    expect(tuple).toBeDefined();
    expect(tuple!.checkpoint.id).toBe('ckpt-1');
    expect(tuple!.checkpoint.channel_values).toEqual({ greeting: 'hello' });
    expect(tuple!.metadata?.source).toBe('input');
  });

  it('returns the latest checkpoint when getTuple is called without a checkpoint_id', async () => {
    const config = { configurable: { thread_id: 'thread-latest' } };
    await saver.put(config, mkCheckpoint('a'), mkMetadata(), {});
    await saver.put(config, mkCheckpoint('b'), mkMetadata(), {});
    await saver.put(config, mkCheckpoint('c'), mkMetadata(), {});

    const tuple = await saver.getTuple(config);

    // Checkpoint IDs sort lexically in DESC; "c" is newest.
    expect(tuple?.checkpoint.id).toBe('c');
  });

  it('enforces the optimistic-concurrency guard on divergent parent lineages', async () => {
    const threadId = 'thread-race';
    const baseConfig = { configurable: { thread_id: threadId } };

    // Write the canonical checkpoint with parent = "p1".
    const configWithP1 = { configurable: { thread_id: threadId, checkpoint_id: 'p1' } };
    await saver.put(configWithP1, mkCheckpoint('child'), mkMetadata(), {});

    // A second writer comes in claiming the same child checkpoint descends from
    // a DIFFERENT parent. The ConditionExpression on the metadata Put should
    // reject with a TransactionCanceledException (ConditionalCheckFailed).
    const configWithP2 = { configurable: { thread_id: threadId, checkpoint_id: 'p2' } };
    await expect(
      saver.put(configWithP2, mkCheckpoint('child'), mkMetadata(), {}),
    ).rejects.toMatchObject({ name: 'TransactionCanceledException' });

    // Canonical lineage is preserved.
    const tuple = await saver.getTuple({
      configurable: { thread_id: threadId, checkpoint_id: 'child' },
    });
    expect(tuple?.parentConfig?.configurable?.checkpoint_id).toBe('p1');

    // Clear unused var lint.
    void baseConfig;
  });

  it('treats an idempotent retry with the same parent/type as a success (no CCFE)', async () => {
    const config = { configurable: { thread_id: 'thread-idem', checkpoint_id: 'parent-x' } };
    const checkpoint = mkCheckpoint('child-idem');
    const metadata = mkMetadata();

    await saver.put(config, checkpoint, metadata, {});
    // Same (parent, type) — retry must not throw.
    await expect(saver.put(config, checkpoint, metadata, {})).resolves.toBeDefined();
  });

  it('paginates list() in descending order and respects limit', async () => {
    const config = { configurable: { thread_id: 'thread-list' } };
    for (const id of ['c01', 'c02', 'c03', 'c04', 'c05']) {
      await saver.put(config, mkCheckpoint(id), mkMetadata(), {});
    }

    const collected: string[] = [];
    for await (const tuple of saver.list(config, { limit: 3 })) {
      collected.push(tuple.checkpoint.id);
    }

    expect(collected).toEqual(['c05', 'c04', 'c03']);
  });

  it('putWrites + getTuple surfaces pending writes alongside the checkpoint', async () => {
    const config = {
      configurable: {
        thread_id: 'thread-writes',
        checkpoint_id: 'ckpt-writes',
        checkpoint_ns: '',
      },
    };
    await saver.put(
      { configurable: { thread_id: 'thread-writes' } },
      mkCheckpoint('ckpt-writes'),
      mkMetadata(),
      {},
    );

    await saver.putWrites(config, [['channel-a', { payload: 'hello' }]], 'task-1');

    const tuple = await saver.getTuple(config);
    expect(tuple?.pendingWrites).toHaveLength(1);
    const [taskId, channel, value] = tuple!.pendingWrites![0];
    expect(taskId).toBe('task-1');
    expect(channel).toBe('channel-a');
    expect(value).toEqual({ payload: 'hello' });
  });

  it('honors config.signal — a pre-aborted signal short-circuits put()', async () => {
    const controller = new AbortController();
    controller.abort(new Error('user cancelled'));

    // The signal is pre-aborted, so withRetry should reject before issuing the
    // transactWrite at all. Any DynamoDB call would succeed (DDB Local is up),
    // so the only way this throws the exact user message is if the signal
    // made it through the full saver → action → retry plumbing.
    await expect(
      saver.put(
        {
          configurable: { thread_id: 'thread-abort' },
          signal: controller.signal,
        },
        mkCheckpoint('ckpt-abort'),
        mkMetadata(),
        {},
      ),
    ).rejects.toThrow('user cancelled');
  });

  it('deleteThread removes every item belonging to the thread', async () => {
    const threadId = 'thread-delete';
    const config = { configurable: { thread_id: threadId } };
    await saver.put(config, mkCheckpoint('d1'), mkMetadata(), {});
    await saver.put(config, mkCheckpoint('d2'), mkMetadata(), {});
    await saver.putWrites(
      { configurable: { thread_id: threadId, checkpoint_id: 'd2', checkpoint_ns: '' } },
      [['c', { x: 1 }]],
      'task-del',
    );

    await saver.deleteThread(threadId);

    const tuple = await saver.getTuple(config);
    expect(tuple).toBeUndefined();

    // list() should also be empty.
    const anyLeft: unknown[] = [];
    for await (const t of saver.list(config)) anyLeft.push(t);
    expect(anyLeft).toEqual([]);
  });
});
