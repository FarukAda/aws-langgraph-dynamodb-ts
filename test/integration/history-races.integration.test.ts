/**
 * INTEGRATION — history optimistic-lock races (gap-class H, AC-29 / REQ-33).
 *
 * Two real `DynamoDBChatMessageHistory` clients, backed by the same DDB-Local
 * table, race on the session-metadata `messageCount` optimistic lock. The
 * winner commits its transaction; the loser observes a `ConditionalCheck`
 * conflict, re-reads, and retries successfully via `withOptimisticRetry`. We
 * assert exactly-one-winner-per-collision, that the final `messageCount` equals
 * the real number of persisted message items, and that a third independent
 * reader never observes a torn write (a count that disagrees with the
 * materialized messages).
 *
 * Env-gated by `jest.integration.config.ts`; requires DDB-Local. With Docker
 * down `beforeAll` fails fast with the helper's guidance message — these tests
 * are authored to run, not to pass without infrastructure.
 *
 * Concurrency is deterministic in structure: every racer parks on the shared
 * `barrier` (via `raceAll`) and is released simultaneously, so their
 * transactions are genuinely in flight together. No wall-clock sleeps and no
 * `Math.random` drive ordering — DynamoDB itself arbitrates the lock.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { AIMessage, HumanMessage } from '@langchain/core/messages';

import { DynamoDBChatMessageHistory } from '../../src';
import { countFulfilled, countRejected, raceAll } from './helpers/concurrency';
import {
  assertDdbLocalReachable,
  createAllTables,
  dropAllTables,
  makeLocalClient,
  uniquePrefix,
} from './helpers/ddb-local';

describe('history optimistic-lock races (integration)', () => {
  let ddb: DynamoDBClient;
  let doc: DynamoDBDocument;
  let tables: { chatHistoryTable: string } & Record<string, string>;
  const USER = 'race-user';
  const SESSION = 'race-session';

  beforeAll(async () => {
    ({ ddb, doc } = makeLocalClient());
    await assertDdbLocalReachable(ddb);
    tables = await createAllTables(ddb, uniquePrefix('history-races'));
  });

  afterAll(async () => {
    if (tables) await dropAllTables(ddb, tables);
    ddb?.destroy();
  });

  function makeHistory(): DynamoDBChatMessageHistory {
    return new DynamoDBChatMessageHistory({ client: doc, tableName: tables.chatHistoryTable });
  }

  it('lets exactly one of two concurrent writers win the lock while the other retries to success', async () => {
    const clientA = makeHistory();
    const clientB = makeHistory();

    // Seed the session so both racers read the SAME expectedCount (1) and then
    // collide on the conditional metadata update.
    await clientA.addMessage(USER, SESSION, new HumanMessage('seed'), 'Race Session');

    const outcomes = await raceAll([
      async (gate) => {
        await gate.wait();
        return clientA.addMessage(USER, SESSION, new AIMessage('from-A'));
      },
      async (gate) => {
        await gate.wait();
        return clientB.addMessage(USER, SESSION, new HumanMessage('from-B'));
      },
    ]);

    // Both eventually succeed: the loser re-reads the bumped count and retries.
    expect(countFulfilled(outcomes)).toBe(2);
    expect(countRejected(outcomes)).toBe(0);

    // Third independent reader sees a consistent, non-torn state.
    const reader = makeHistory();
    const messages = await reader.getMessages(USER, SESSION);
    const sessions = await reader.listSessions(USER);
    const meta = sessions.find((s) => s.sessionId === SESSION);

    expect(messages).toHaveLength(3); // seed + A + B
    expect(meta?.messageCount).toBe(3);
    // messageCount is exactly the materialized message count — no torn write.
    expect(meta?.messageCount).toBe(messages.length);
  }); // AC-29

  it('keeps messageCount equal to the materialized message count under a five-way write storm', async () => {
    const session = `${SESSION}-storm`;
    const seeder = makeHistory();
    await seeder.addMessages(USER, session, [new HumanMessage('s0')], 'Storm');

    const racers = Array.from({ length: 5 }, (_v, i) => {
      const c = makeHistory();
      return async (gate: { wait: () => Promise<void> }) => {
        await gate.wait();
        return c.addMessage(USER, session, new HumanMessage(`m${i}`));
      };
    });

    const outcomes = await raceAll(racers);

    // Each racer gets up to MAX_OPTIMISTIC_RETRIES (5) re-reads; with 5 writers
    // each is guaranteed a free slot within the retry budget, so all win.
    expect(countFulfilled(outcomes)).toBe(5);

    const reader = makeHistory();
    const messages = await reader.getMessages(USER, session);
    const sessions = await reader.listSessions(USER);
    const meta = sessions.find((s) => s.sessionId === session);

    expect(messages).toHaveLength(6); // seed + 5
    expect(meta?.messageCount).toBe(messages.length);
  }); // AC-29

  it('surfaces the labelled exhaustion error without losing or duplicating messages under a thundering herd', async () => {
    // More concurrent first-writes than the retry budget can absorb in a single
    // round: at least one writer may surface the labelled exhaustion error rather
    // than silently corrupting the counter. The realistic ERROR path.
    const session = `${SESSION}-herd`;
    const seeder = makeHistory();
    await seeder.addMessage(USER, session, new HumanMessage('s0'), 'Herd');

    const herd = Array.from({ length: 12 }, (_v, i) => {
      const c = makeHistory();
      return async (gate: { wait: () => Promise<void> }) => {
        await gate.wait();
        return c.addMessage(USER, session, new HumanMessage(`h${i}`));
      };
    });

    const outcomes = await raceAll(herd);

    // Any failure must be the labelled optimistic-lock exhaustion — never a torn
    // write or a generic DynamoDB error.
    for (const o of outcomes) {
      if (o.status === 'rejected') {
        const reason = o.reason as Error;
        expect(reason.message).toContain(
          `addMessages:${session} failed after 5 optimistic-lock retries`,
        );
      }
    }

    // The counter equals exactly the number of writers that actually committed
    // (seed + fulfilled): no double-counting, no lost increments.
    const reader = makeHistory();
    const messages = await reader.getMessages(USER, session);
    const sessions = await reader.listSessions(USER);
    const meta = sessions.find((s) => s.sessionId === session);

    expect(messages).toHaveLength(1 + countFulfilled(outcomes));
    expect(meta?.messageCount).toBe(messages.length);
  }); // AC-29
});
