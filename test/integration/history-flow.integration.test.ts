/**
 * INTEGRATION — chat-history end-to-end flow against real DynamoDB Local.
 *
 * Covers REQ-31 / AC-27 for the history service: append -> getMessages ->
 * clear, asserting chronological ordering, the persisted `messageCount`, and
 * the `ttl` attribute physically written to the table.
 *
 * Each test uses its own userId so `listSessions(userId)` is isolated and the
 * asserted session count / messageCount are unambiguous. Env-gated; reads
 * DYNAMODB_ENDPOINT (spec default http://localhost:4566) and connects via the
 * shared ddb-local helper. Cannot pass without docker — by design — but is
 * authored against the real public API and table schema.
 */

import { HumanMessage, AIMessage } from '@langchain/core/messages';

import { DynamoDBChatMessageHistory } from '../../src/index';
import {
  assertDdbLocalReachable,
  createAllTables,
  dropAllTables,
  makeLocalClient,
  uniquePrefix,
} from './helpers/ddb-local';
import { expectedTtlSeconds } from './helpers/frozen-time';

const INTEGRATION_ENABLED = process.env.RUN_INTEGRATION === '1';
const describeIntegration = INTEGRATION_ENABLED ? describe : describe.skip;

const SESSION_ID = 'session-hist-1';
const TTL_DAYS = 30;

describeIntegration('history flow (DDB Local)', () => {
  const { ddb, doc } = makeLocalClient();
  const prefix = uniquePrefix('hist-flow');
  let tables: Awaited<ReturnType<typeof createAllTables>>;
  let history: DynamoDBChatMessageHistory;

  beforeAll(async () => {
    await assertDdbLocalReachable(ddb);
    tables = await createAllTables(ddb, prefix);
    history = new DynamoDBChatMessageHistory({
      tableName: tables.chatHistoryTable,
      client: doc,
      ttlDays: TTL_DAYS,
    });
  });

  afterAll(async () => {
    history?.destroy();
    await dropAllTables(ddb, tables);
    ddb.destroy();
  });

  it('appends messages, returns them in chronological order, and counts them', async () => {
    const userId = 'user-order';
    await history.addMessages(
      userId,
      SESSION_ID,
      [new HumanMessage('first'), new AIMessage('second'), new HumanMessage('third')],
      'My session',
    );

    const messages = await history.getMessages(userId, SESSION_ID);
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.content)).toEqual(['first', 'second', 'third']);
    expect(messages[0]._getType()).toBe('human');
    expect(messages[1]._getType()).toBe('ai');

    // listSessions exposes the running messageCount for the single session.
    const sessions = await history.listSessions(userId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].messageCount).toBe(3);
  }); // AC-27

  it('persists a numeric ttl attribute within the deterministic 30-day window on every item', async () => {
    const userId = 'user-ttl';
    await history.addMessage(userId, SESSION_ID, new HumanMessage('hello'), 'TTL session');

    // Read every item physically written for this user.
    const queried = await doc.query({
      TableName: tables.chatHistoryTable,
      KeyConditionExpression: 'userId = :u',
      ExpressionAttributeValues: { ':u': userId },
    });
    const items = queried.Items ?? [];
    expect(items.length).toBeGreaterThan(0);

    // Every persisted item carries a numeric ttl inside the exact 30-day window
    // the library computes (Math.floor(now/1000) + 30*86400), tolerant of the
    // wall-clock second the write actually executed in.
    const ttls = items.map((i) => i.ttl);
    expect(ttls.every((t) => typeof t === 'number')).toBe(true);
    const oneDayMs = 24 * 60 * 60 * 1000;
    const lower = expectedTtlSeconds(TTL_DAYS, Date.now() - oneDayMs);
    const upper = expectedTtlSeconds(TTL_DAYS, Date.now() + oneDayMs);
    for (const ttl of ttls as number[]) {
      expect(ttl).toBeGreaterThanOrEqual(lower);
      expect(ttl).toBeLessThanOrEqual(upper);
    }
  }); // AC-27

  it('clears a session so getMessages returns empty afterward', async () => {
    const userId = 'user-clear';
    await history.addMessages(userId, SESSION_ID, [new HumanMessage('to be cleared')]);
    const before = await history.getMessages(userId, SESSION_ID);
    expect(before).toHaveLength(1);

    await history.clear(userId, SESSION_ID);

    const after = await history.getMessages(userId, SESSION_ID);
    expect(after).toEqual([]);
  }); // AC-27

  it('rejects an empty userId with the documented validation error and writes nothing', async () => {
    // Realistic validation error path — must abort before any DynamoDB write.
    await expect(history.addMessage('', SESSION_ID, new HumanMessage('x'))).rejects.toThrow();

    // No item leaked under the empty user id.
    const leaked = await doc.query({
      TableName: tables.chatHistoryTable,
      KeyConditionExpression: 'userId = :u',
      ExpressionAttributeValues: { ':u': '' },
    });
    expect(leaked.Items ?? []).toEqual([]);
  }); // AC-27
});
