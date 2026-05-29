/**
 * INTEGRATION — checkpointer optimistic-lock races (gap-class H, AC-29 / REQ-33).
 *
 * Two real `DynamoDBSaver` instances, backed by the same DDB-Local checkpoints
 * table, race concurrent `put()` calls on the SAME (thread_id, checkpoint_id).
 * The metadata `Put` carries the conditional guard:
 *
 *   attribute_not_exists(checkpoint_id)
 *   OR (#type = :expected_type AND (parent clause))
 *
 * so two writers that agree on parent+type (a legitimate idempotent retry) both
 * succeed, whereas two writers that DISAGREE on lineage produce a
 * `ConditionalCheckFailed` / `TransactionCanceled` on the loser — surfaced, not
 * silently resolved. We assert exactly-one-winner on the divergent race, the
 * documented conflict semantics, and a consistent final state read back via
 * `getTuple`.
 *
 * Env-gated by `jest.integration.config.ts`; requires DDB-Local. `beforeAll`
 * fails fast with guidance when Docker is down. Racers release together from a
 * shared `barrier` (`raceAll`) — no wall-clock sleeps, no `Math.random`.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { DynamoDBSaver } from '../../src';
import { raceAll } from './helpers/concurrency';
import {
  assertDdbLocalReachable,
  createAllTables,
  dropAllTables,
  makeLocalClient,
  uniquePrefix,
} from './helpers/ddb-local';

const THREAD = 'race-thread';
const CHECKPOINT_ID = '1ef00000-0000-6000-8000-000000000001';

function makeCheckpoint(id: string): Checkpoint {
  return {
    v: 1,
    id,
    ts: '2026-05-28T00:00:00.000Z',
    channel_values: { messages: ['hello'] },
    channel_versions: { messages: 1 },
    versions_seen: { __input__: {} },
    pending_sends: [],
  } as unknown as Checkpoint;
}

function makeMetadata(source: CheckpointMetadata['source']): CheckpointMetadata {
  return { source, step: 1, parents: {} } as CheckpointMetadata;
}

function configFor(threadId: string, parentCheckpointId?: string): RunnableConfig {
  return {
    configurable: {
      thread_id: threadId,
      checkpoint_ns: '',
      ...(parentCheckpointId ? { checkpoint_id: parentCheckpointId } : {}),
    },
  };
}

describe('checkpointer optimistic-lock races (integration)', () => {
  let ddb: DynamoDBClient;
  let doc: DynamoDBDocument;
  let tables: { checkpointsTable: string; writesTable: string } & Record<string, string>;

  beforeAll(async () => {
    ({ ddb, doc } = makeLocalClient());
    await assertDdbLocalReachable(ddb);
    tables = await createAllTables(ddb, uniquePrefix('checkpointer-races'));
  });

  afterAll(async () => {
    if (tables) await dropAllTables(ddb, tables);
    ddb?.destroy();
  });

  function makeSaver(): DynamoDBSaver {
    return new DynamoDBSaver({
      client: doc,
      checkpointsTableName: tables.checkpointsTable,
      writesTableName: tables.writesTable,
    });
  }

  it('lets two idempotent concurrent puts (same parent+type) both succeed with a single coherent stored checkpoint', async () => {
    const saverA = makeSaver();
    const saverB = makeSaver();
    const thread = `${THREAD}-idem`;
    const cfg = configFor(thread);
    const ckpt = makeCheckpoint(CHECKPOINT_ID);
    const meta = makeMetadata('input');

    const outcomes = await raceAll([
      async (gate) => {
        await gate.wait();
        return saverA.put(cfg, ckpt, meta, {});
      },
      async (gate) => {
        await gate.wait();
        return saverB.put(cfg, ckpt, meta, {});
      },
    ]);

    // Same lineage ⇒ the conditional guard permits the idempotent overwrite.
    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled']);

    const reader = makeSaver();
    const tuple = await reader.getTuple({
      configurable: { thread_id: thread, checkpoint_ns: '', checkpoint_id: CHECKPOINT_ID },
    });
    expect(tuple?.checkpoint.id).toBe(CHECKPOINT_ID);
    expect(tuple?.metadata?.source).toBe('input');
  }); // AC-29

  it('surfaces a ConditionalCheckFailed conflict on the loser when two puts diverge on lineage', async () => {
    const saverA = makeSaver();
    const saverB = makeSaver();
    const thread = `${THREAD}-divergent`;
    const ckpt = makeCheckpoint(CHECKPOINT_ID);

    // A claims "initial checkpoint" (no parent); B claims a named parent for the
    // SAME checkpoint_id — divergent lineage the guard must reject for one writer.
    const outcomes = await raceAll([
      async (gate) => {
        await gate.wait();
        return saverA.put(configFor(thread), ckpt, makeMetadata('input'), {});
      },
      async (gate) => {
        await gate.wait();
        return saverB.put(
          configFor(thread, '1ef00000-0000-6000-8000-0000000000aa'),
          ckpt,
          makeMetadata('loop'),
          {},
        );
      },
    ]);

    const statuses = outcomes.map((o) => o.status);
    // Exactly one winner, exactly one rejection — never both-win (silent corruption).
    expect(statuses.filter((s) => s === 'fulfilled')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'rejected')).toHaveLength(1);

    const rejected = outcomes.find((o) => o.status === 'rejected');
    const errName = (rejected as { reason: { name?: string } }).reason.name;
    expect(['ConditionalCheckFailedException', 'TransactionCanceledException']).toContain(errName);

    // The winner's checkpoint is the one a third reader sees — coherent state.
    const reader = makeSaver();
    const tuple = await reader.getTuple({
      configurable: { thread_id: thread, checkpoint_ns: '', checkpoint_id: CHECKPOINT_ID },
    });
    expect(tuple?.checkpoint.id).toBe(CHECKPOINT_ID);
    // Whichever writer won, getTuple returns its metadata source intact, not a blend.
    expect(['input', 'loop']).toContain(tuple?.metadata?.source);
  }); // AC-29
});
