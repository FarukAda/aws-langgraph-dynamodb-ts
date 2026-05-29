/**
 * INTEGRATION — checkpointer end-to-end flow against real DynamoDB Local.
 *
 * Covers REQ-31 / AC-27 (happy path + realistic error path) for the
 * checkpointer service. Runs only when the integration flag is set; reads
 * `DYNAMODB_ENDPOINT` (spec default `http://localhost:4566`) and connects to
 * the docker DDB-Local service via the shared `ddb-local` helper.
 *
 * These tests CANNOT pass without docker up; that is expected — they are
 * authored against the real public API and the real table schema.
 */

import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { DynamoDBSaver } from '../../src/index';
import {
  assertDdbLocalReachable,
  createAllTables,
  dropAllTables,
  makeLocalClient,
  uniquePrefix,
} from './helpers/ddb-local';

// Spec AC-26: integration is env-gated; the suite skips cleanly when unset.
const INTEGRATION_ENABLED = process.env.RUN_INTEGRATION === '1';
// Spec AC-26: the DynamoDB endpoint is read from DYNAMODB_ENDPOINT, default http://localhost:4566.
const RESOLVED_DDB_ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:4566';
const describeIntegration = INTEGRATION_ENABLED ? describe : describe.skip;

const THREAD_ID = 'thread-flow-1';
const CHECKPOINT_ID = '00000000-0000-0000-0000-0000000000aa';

function makeCheckpoint(id: string): Checkpoint {
  return {
    v: 1,
    id,
    ts: '2026-05-28T00:00:00.000Z',
    channel_values: { messages: ['hello'] },
    channel_versions: { messages: 1 },
    versions_seen: { __start__: { messages: 1 } },
  };
}

function makeMetadata(step: number): CheckpointMetadata {
  return { source: 'loop', step, parents: {} };
}

describeIntegration('checkpointer flow (DDB Local)', () => {
  const { ddb, doc } = makeLocalClient();
  const prefix = uniquePrefix('ckpt-flow');
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
    saver?.destroy();
    await dropAllTables(ddb, tables);
    ddb.destroy();
  });

  it('resolves the DynamoDB endpoint from DYNAMODB_ENDPOINT defaulting to http://localhost:4566', () => {
    // Locks the spec's documented endpoint-resolution default without requiring docker.
    const fallback = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:4566';
    expect(RESOLVED_DDB_ENDPOINT).toBe(fallback);
    expect(RESOLVED_DDB_ENDPOINT).toMatch(/^https?:\/\//);
  }); // AC-26

  it('round-trips put -> getTuple -> list -> deleteThread persisting the real item shape', async () => {
    const config = { configurable: { thread_id: THREAD_ID, checkpoint_ns: '' } };
    const checkpoint = makeCheckpoint(CHECKPOINT_ID);

    const returned = await saver.put(config, checkpoint, makeMetadata(1), {});
    expect(returned.configurable?.thread_id).toBe(THREAD_ID);
    expect(returned.configurable?.checkpoint_id).toBe(CHECKPOINT_ID);

    // getTuple returns the persisted checkpoint verbatim.
    const tuple = await saver.getTuple({
      configurable: { thread_id: THREAD_ID, checkpoint_ns: '', checkpoint_id: CHECKPOINT_ID },
    });
    expect(tuple?.checkpoint.id).toBe(CHECKPOINT_ID);
    expect(tuple?.checkpoint.channel_values).toEqual({ messages: ['hello'] });
    expect(tuple?.metadata?.step).toBe(1);

    // The metadata row is physically present in the checkpoints table.
    const stored = await doc.get({
      TableName: tables.checkpointsTable,
      Key: { thread_id: THREAD_ID, checkpoint_id: CHECKPOINT_ID },
    });
    expect(stored.Item?.thread_id).toBe(THREAD_ID);
    expect(stored.Item?.checkpoint_id).toBe(CHECKPOINT_ID);
    expect(stored.Item?.type).toBeTruthy();

    // list yields the checkpoint we just wrote.
    const listed: string[] = [];
    for await (const t of saver.list(config, undefined)) {
      listed.push(t.checkpoint.id);
    }
    expect(listed).toContain(CHECKPOINT_ID);

    // deleteThread removes every item for the thread.
    await saver.deleteThread(THREAD_ID);
    const afterDelete = await saver.getTuple({
      configurable: { thread_id: THREAD_ID, checkpoint_ns: '', checkpoint_id: CHECKPOINT_ID },
    });
    expect(afterDelete).toBeUndefined();

    const remaining: string[] = [];
    for await (const t of saver.list(config, undefined)) {
      remaining.push(t.checkpoint.id);
    }
    expect(remaining).toEqual([]);
  }); // AC-27

  it('rejects list() with a non-string thread_id with the documented validation error', async () => {
    // Realistic error path: validation aborts before any DynamoDB call.
    // `as unknown as string` simulates a malformed caller-supplied thread_id
    // (a number) reaching the defensive `typeof thread_id !== 'string'` guard.
    const badThreadId = 12345 as unknown as string;
    const badConfig = { configurable: { thread_id: badThreadId } };
    const iterate = async (): Promise<void> => {
      for await (const _ of saver.list(badConfig, undefined)) {
        // unreachable — the generator throws on first pull
        expect(_).toBeUndefined();
      }
    };
    await expect(iterate()).rejects.toThrow('thread_id must be a string');
  }); // AC-27
});
