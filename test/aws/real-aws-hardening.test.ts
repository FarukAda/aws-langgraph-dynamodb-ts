import { randomUUID } from 'node:crypto';

import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
  waitUntilTableNotExists,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { HumanMessage } from '@langchain/core/messages';
import type { Checkpoint } from '@langchain/langgraph-checkpoint';

import { sessionPartition } from '../../src/history/internal/rows';
import { DynamoDBChatMessageHistory, DynamoDBFactory, ErrorCode } from '../../src/index';
import { awsError, installFaults } from '../integration/helpers/fault-injection';
import { liveRegion } from './helpers/env';

const clientConfig = { region: liveRegion() };
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

  it('deleteThread leaves the chat history and store data intact', async () => {
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

  it('history.clear leaves the checkpoints and store data intact', async () => {
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

  it('a store namespace shaped like a checkpoint key cannot reach the checkpoint', async () => {
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

  it('a store namespace shaped like a session key cannot reach the session', async () => {
    const built = adapters();
    const id = 'conv-4';
    try {
      await built.history.addMessages(id, [new HumanMessage('real message')]);
      await built.store.put([id, 'HISTORY'], 'SESSION', { text: 'not a session' });

      expect((await built.history.getMessages(id)).map((m) => m.content)).toEqual(['real message']);
      const { sessions: sessions } = await built.history.listSessions();
      expect(sessions.find((s) => s.sessionId === id)?.messageCount).toBe(1);
      const stored = await built.store.get([id, 'HISTORY'], 'SESSION');
      expect(stored?.value).toEqual({ text: 'not a session' });
    } finally {
      built.destroy();
    }
  });

  it('a retried task with a changed write mix loses no write and duplicates none', async () => {
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

  /**
   * The row is read back raw, not through `listSessions`: a ghost session is
   * a row with `messageCount: 0` and a title, and a listing that happened to
   * hide such a row would pass a weaker check while the row stayed behind.
   */
  async function sessionRow(id: string) {
    const raw = await DynamoDBDocument.from(admin).get({
      TableName: tableName,
      Key: { PK: sessionPartition(id), SK: 'HISTORY#SESSION' },
      ConsistentRead: true,
    });
    return raw.Item;
  }

  it('an append refused before anything is written leaves no session row behind', async () => {
    const built = adapters();
    const id = 'conv-6';
    try {
      // Every message is encoded before any chunk is sent, so one message no
      // row can hold refuses the whole call at the encode, with nothing to
      // roll back — and nothing left behind.
      const messages = Array.from({ length: 104 }, (_, i) => new HumanMessage(`tiny message ${i}`));
      messages.push(new HumanMessage('x'.repeat(450_000)));

      await expect(built.history.addMessages(id, messages)).rejects.toMatchObject({
        code: ErrorCode.VALIDATION,
      });

      expect(await built.history.getMessages(id)).toEqual([]);
      expect(await sessionRow(id)).toBeUndefined();
    } finally {
      built.destroy();
    }
  });

  /**
   * The real rollback, against the real service: the first chunk of 150
   * messages commits — its 99 rows and the session row this call creates —
   * and the second is refused by injected middleware, so the rows the first
   * wrote are deleted with real `BatchWriteItem`s and the session row this
   * call created is removed under its real conditional delete.
   */
  it('a rolled-back multi-chunk append leaves no ghost session', async () => {
    const base = new DynamoDBClient(clientConfig);
    installFaults(base, [
      {
        match: (_name, input) =>
          Array.isArray((input as { TransactItems?: unknown[] }).TransactItems),
        fail: () => awsError('ValidationException', 'injected chunk-2 failure'),
        skip: 1,
        times: 1,
      },
    ]);
    const history = new DynamoDBChatMessageHistory({
      tableName,
      client: DynamoDBDocument.from(base),
    });
    const id = 'conv-6-rollback';
    try {
      const messages = Array.from({ length: 150 }, (_, i) => new HumanMessage(`m${i}`));

      await expect(history.addMessages(id, messages)).rejects.toThrow('injected chunk-2');

      expect(await history.getMessages(id)).toEqual([]);
      expect(await sessionRow(id)).toBeUndefined();
    } finally {
      history.destroy();
      base.destroy();
    }
  });

  it('an identifier carrying a control character is rejected, not persisted', async () => {
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

  it('a range filter does not match a numeric-looking string', async () => {
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
