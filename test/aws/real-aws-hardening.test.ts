import { randomUUID } from 'node:crypto';

import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
  waitUntilTableNotExists,
} from '@aws-sdk/client-dynamodb';
import { HumanMessage } from '@langchain/core/messages';
import type { Checkpoint } from '@langchain/langgraph-checkpoint';

import { DynamoDBFactory } from '../../src/index';

const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
const clientConfig = region ? { region } : {};
const tableName = `aws-langgraph-hardeningtest-${randomUUID()}`;

/** One identifier reused as a thread id, a session id, and a namespace root. */
const SHARED_ID = 'conv-1';

function checkpoint(id: string): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date(0).toISOString(),
    channel_values: { messages: ['x'] },
    channel_versions: { messages: 1 },
    versions_seen: {},
  };
}

const metadata = { source: 'loop' as const, step: 1, parents: {} };

/**
 * Real-AWS regression suite for the Critical findings of the 2026-08-29
 * review. Every case here reproduces against 0.7.0 and must not against this
 * release. These run against a real table rather than DynamoDB Local because
 * the findings were about what the *service* actually does with these keys and
 * conditions — a partition-wide Query's result set, a conditional delete's
 * cancellation reason, and a genuine item-size rejection.
 */
describe('v0.8.0 hardening against real AWS', () => {
  let admin: DynamoDBClient;

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
    await waitUntilTableExists({ client: admin, maxWaitTime: 120 }, { TableName: tableName });
  });

  afterAll(async () => {
    if (admin) {
      await admin.send(new DeleteTableCommand({ TableName: tableName }));
      await waitUntilTableNotExists({ client: admin, maxWaitTime: 120 }, { TableName: tableName });
      admin.destroy();
    }
  });

  function adapters() {
    return new DynamoDBFactory({ clientConfig }).createAll({
      saver: { tableName },
      store: { tableName },
      history: { tableName },
    });
  }

  /** Seed all three adapters under one shared identifier. */
  async function seedAll(id: string, built: ReturnType<typeof adapters>): Promise<void> {
    await built.saver.put(
      { configurable: { thread_id: id, checkpoint_ns: '' } },
      checkpoint('cp-1'),
      metadata,
    );
    await built.history.addMessages(id, [new HumanMessage('chat content')]);
    await built.store.put([id, 'docs'], 'doc-1', { text: 'store content' });
  }

  it('C1: deleteThread leaves the chat history and store data intact', async () => {
    const built = adapters();
    try {
      await seedAll(SHARED_ID, built);
      await built.saver.deleteThread(SHARED_ID);

      const messages = await built.history.getMessages(SHARED_ID);
      expect(messages.map((m) => m.content)).toEqual(['chat content']);
      const stored = await built.store.get([SHARED_ID, 'docs'], 'doc-1');
      expect(stored?.value).toEqual({ text: 'store content' });
      // The thread's own data is gone, as asked.
      const tuple = await built.saver.getTuple({ configurable: { thread_id: SHARED_ID } });
      expect(tuple).toBeUndefined();
    } finally {
      built.destroy();
    }
  });

  it('C1: history.clear leaves the checkpoints and store data intact', async () => {
    const built = adapters();
    const id = 'conv-2';
    try {
      await seedAll(id, built);
      await built.history.clear(id);

      const tuple = await built.saver.getTuple({ configurable: { thread_id: id } });
      expect(tuple?.checkpoint.id).toBe('cp-1');
      const stored = await built.store.get([id, 'docs'], 'doc-1');
      expect(stored?.value).toEqual({ text: 'store content' });
      expect(await built.history.getMessages(id)).toEqual([]);
    } finally {
      built.destroy();
    }
  });

  it('C2: a store namespace shaped like a checkpoint key cannot reach the checkpoint', async () => {
    const built = adapters();
    const id = 'conv-3';
    try {
      // A non-root checkpoint namespace, since upstream BaseStore rejects an
      // empty namespace label and so cannot express the root-namespace shape.
      await built.saver.put(
        { configurable: { thread_id: id, checkpoint_ns: 'inner' } },
        checkpoint('cp-9'),
        metadata,
      );
      // Composes SK 'META#inner#cp-9' — byte-identical to the checkpoint's
      // meta row, which under the old untagged partition key put both in one
      // partition at the very same key.
      await built.store.put([id, 'META', 'inner'], 'cp-9', { text: 'not a checkpoint' });

      const tuple = await built.saver.getTuple({
        configurable: { thread_id: id, checkpoint_ns: 'inner', checkpoint_id: 'cp-9' },
      });
      expect(tuple?.checkpoint.id).toBe('cp-9');
      expect(tuple?.metadata).toMatchObject({ step: 1 });

      const stored = await built.store.get([id, 'META', 'inner'], 'cp-9');
      expect(stored?.value).toEqual({ text: 'not a checkpoint' });
    } finally {
      built.destroy();
    }
  });

  it('C2: a store namespace shaped like a session key cannot reach the session', async () => {
    const built = adapters();
    const id = 'conv-4';
    try {
      await built.history.addMessages(id, [new HumanMessage('real message')]);
      await built.store.put([id, 'HISTORY'], 'SESSION', { text: 'not a session' });

      expect((await built.history.getMessages(id)).map((m) => m.content)).toEqual(['real message']);
      const sessions = await built.history.listSessions();
      expect(sessions.find((s) => s.sessionId === id)?.messageCount).toBe(1);
      const stored = await built.store.get([id, 'HISTORY'], 'SESSION');
      expect(stored?.value).toEqual({ text: 'not a session' });
    } finally {
      built.destroy();
    }
  });

  it('C3: a retried task with a changed write mix loses no write and duplicates none', async () => {
    const built = adapters();
    const id = 'conv-5';
    const config = { configurable: { thread_id: id, checkpoint_ns: '', checkpoint_id: 'cp-w' } };
    try {
      await built.saver.put(
        { configurable: { thread_id: id, checkpoint_ns: '' } },
        checkpoint('cp-w'),
        metadata,
      );
      await built.saver.putWrites(config, [['chanA', 'value-a']], 'task-1');
      // The task re-runs and now also writes chanB, which takes chanA's former
      // array position.
      await built.saver.putWrites(
        config,
        [
          ['chanB', 'value-b'],
          ['chanA', 'value-a'],
        ],
        'task-1',
      );

      const tuple = await built.saver.getTuple(config);
      const writes = (tuple?.pendingWrites ?? []).map(([, channel, value]) => [channel, value]);
      expect(writes).toEqual(
        expect.arrayContaining([
          ['chanA', 'value-a'],
          ['chanB', 'value-b'],
        ]),
      );
      expect(writes.filter(([channel]) => channel === 'chanA')).toHaveLength(1);
      expect(writes.filter(([channel]) => channel === 'chanB')).toHaveLength(1);
    } finally {
      built.destroy();
    }
  });

  it('C4: a rolled-back multi-chunk append leaves no ghost session', async () => {
    const built = adapters();
    const id = 'conv-6';
    try {
      // 105 messages spans two chunks (99 max per transaction). One oversized
      // message makes the *second* chunk hit a genuine DynamoDB item-size
      // rejection, after the first has already committed.
      const messages = Array.from({ length: 104 }, (_, i) => new HumanMessage(`tiny message ${i}`));
      messages.push(new HumanMessage('x'.repeat(450_000)));

      await expect(built.history.addMessages(id, messages)).rejects.toThrow();

      expect(await built.history.getMessages(id)).toEqual([]);
      const sessions = await built.history.listSessions();
      expect(sessions.find((s) => s.sessionId === id)).toBeUndefined();
    } finally {
      built.destroy();
    }
  });

  it('M7: an identifier carrying a control character is rejected, not persisted', async () => {
    const built = adapters();
    try {
      await expect(
        built.saver.put(
          {
            configurable: { thread_id: `thread${String.fromCharCode(27)}[31m`, checkpoint_ns: '' },
          },
          checkpoint('cp-x'),
          metadata,
        ),
      ).rejects.toThrow(/control characters/);
    } finally {
      built.destroy();
    }
  });

  it('M9: a range filter does not match a numeric-looking string', async () => {
    const built = adapters();
    const id = 'conv-7';
    try {
      await built.store.put([id, 'items'], 'a', { count: '10' });
      await built.store.put([id, 'items'], 'b', { count: 10 });
      const hits = await built.store.search([id, 'items'], { filter: { count: { $gt: 5 } } });
      expect(hits.map((h) => h.key)).toEqual(['b']);
    } finally {
      built.destroy();
    }
  });
});
