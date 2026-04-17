/**
 * End-to-end DynamoDBChatMessageHistory tests against DynamoDB Local.
 *
 * The optimistic-concurrency protocol (read messageCount → transactWrite with
 * condition) is difficult to verify with mocks. These tests drive it through
 * real DynamoDB so the condition, cancellation reasons, and retry semantics
 * are exercised end-to-end.
 */

import { AIMessage, HumanMessage } from '@langchain/core/messages';

import { DynamoDBChatMessageHistory } from '../../src/history';
import {
  assertDdbLocalReachable,
  createAllTables,
  dropAllTables,
  makeLocalClient,
  uniquePrefix,
} from './helpers/ddb-local';

const prefix = uniquePrefix('history');
const { ddb, doc } = makeLocalClient();

let tables: Awaited<ReturnType<typeof createAllTables>>;
let history: DynamoDBChatMessageHistory;

beforeAll(async () => {
  await assertDdbLocalReachable(ddb);
  tables = await createAllTables(ddb, prefix);
  history = new DynamoDBChatMessageHistory({
    tableName: tables.chatHistoryTable,
    client: doc,
  });
});

afterAll(async () => {
  history.destroy();
  await dropAllTables(ddb, tables);
  ddb.destroy();
});

describe('DynamoDBChatMessageHistory against DynamoDB Local', () => {
  it('addMessages + getMessages round-trip preserves order', async () => {
    const userId = 'u-hist-1';
    const sessionId = 's1';

    await history.addMessages(userId, sessionId, [
      new HumanMessage('hi'),
      new AIMessage('hello there'),
      new HumanMessage('how are you?'),
    ]);

    const messages = await history.getMessages(userId, sessionId);
    expect(messages.map((m) => m.content)).toEqual(['hi', 'hello there', 'how are you?']);
  });

  it('listSessions returns every session with its metadata', async () => {
    const userId = 'u-hist-list';
    await history.addMessages(userId, 'a', [new HumanMessage('msg in a')]);
    await history.addMessages(userId, 'b', [new HumanMessage('msg in b')]);

    const sessions = await history.listSessions(userId);
    const ids = sessions.map((s) => s.sessionId).sort();
    expect(ids).toEqual(['a', 'b']);
    for (const s of sessions) {
      expect(s.messageCount).toBeGreaterThan(0);
      expect(typeof s.title).toBe('string');
    }
  });

  it('clear() removes all messages and the session metadata', async () => {
    const userId = 'u-hist-clear';
    const sessionId = 'c1';
    await history.addMessages(userId, sessionId, [new HumanMessage('delete me')]);

    await history.clear(userId, sessionId);

    const remaining = await history.getMessages(userId, sessionId);
    expect(remaining).toEqual([]);
    const sessions = await history.listSessions(userId);
    expect(sessions.find((s) => s.sessionId === sessionId)).toBeUndefined();
  });

  it('optimistic-concurrency retry survives a concurrent add on the same session', async () => {
    const userId = 'u-hist-race';
    const sessionId = 'shared';

    // Two concurrent adds on the same (userId, sessionId). One transactWrite
    // will lose the optimistic-count race, trigger a re-read + retry, and both
    // will ultimately succeed. Finish state: 4 messages, sequential indices.
    await Promise.all([
      history.addMessages(userId, sessionId, [new HumanMessage('a'), new HumanMessage('b')]),
      history.addMessages(userId, sessionId, [new AIMessage('c'), new AIMessage('d')]),
    ]);

    const messages = await history.getMessages(userId, sessionId);
    expect(messages).toHaveLength(4);
    // We can't assert the exact interleaving (race order is nondeterministic),
    // but all four contents must be present exactly once.
    const contents = new Set(messages.map((m) => m.content));
    expect(contents).toEqual(new Set(['a', 'b', 'c', 'd']));
  });
});
