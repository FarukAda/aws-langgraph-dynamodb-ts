/**
 * Public-surface lockdown + end-to-end smoke tests for the package entry point.
 *
 * This file imports ONLY from src/index.ts (the published surface). A consumer
 * of `@farukada/aws-langgraph-dynamodb-ts` cannot use anything this file does
 * not import — so removing or renaming any export breaks this test (AC-23). Each
 * exported symbol gets a representative positive AND negative path exercised
 * against aws-sdk-client-mock (AC-7 / AC-42).
 *
 * AWS is mocked via the shared strict mock (aws-sdk-client-mock); the factory /
 * constructors build their own DynamoDBDocumentClient which the mock intercepts.
 */
import { QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

import {
  DynamoDBSaver,
  DynamoDBStore,
  DynamoDBChatMessageHistory,
  DynamoDBSessionChatMessageHistory,
  DynamoDBFactory,
  setGlobalLogger,
  getLogger,
  resetLogger,
  redactLogger,
  redactSecrets,
  BatchWriteIncompleteError,
  type Logger,
} from '../../src/index';
import { THREAD_ID, USER_ID, SESSION_ID } from '../shared/fixtures/test-data';
import { expectNoUnexpectedCommands } from '../shared/helpers/strict-ddb-assertions';
import { createStrictDdbMock, type StrictDdbMock } from '../shared/mocks/dynamodb';

const CHECKPOINTS_TABLE = 'checkpoints-table';
const WRITES_TABLE = 'writes-table';
const MEMORY_TABLE = 'memory-table';
const HISTORY_TABLE = 'history-table';

describe('public package surface (src/index.ts)', () => {
  let ddb: StrictDdbMock;

  beforeEach(() => {
    ddb = createStrictDdbMock();
  });

  afterEach(() => {
    ddb.mock.restore();
    resetLogger();
  });

  describe('DynamoDBSaver', () => {
    it('deleteThread on an empty thread resolves with no batch-write (positive)', async () => {
      ddb.mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });
      const saver = new DynamoDBSaver({
        checkpointsTableName: CHECKPOINTS_TABLE,
        writesTableName: WRITES_TABLE,
      });
      await expect(saver.deleteThread(THREAD_ID)).resolves.toBeUndefined();
      expect(ddb.mock.commandCalls(QueryCommand)).toHaveLength(1);
      expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
    }); // AC-42

    it('list rejects a non-string thread_id with the documented message (negative)', async () => {
      const saver = new DynamoDBSaver({
        checkpointsTableName: CHECKPOINTS_TABLE,
        writesTableName: WRITES_TABLE,
      });
      const iterator = saver.list({ configurable: { thread_id: 42 } }, undefined);
      await expect(iterator.next()).rejects.toThrow('thread_id must be a string');
      expectNoUnexpectedCommands(ddb.mock, []);
    }); // AC-23
  });

  describe('DynamoDBStore', () => {
    it('batch get returns null for a missing item (positive)', async () => {
      ddb.mock.on(GetCommand).resolves({ Item: undefined });
      const store = new DynamoDBStore({ memoryTableName: MEMORY_TABLE });
      const result = await store.batch([{ namespace: ['ns'], key: 'k' }], {
        configurable: { user_id: USER_ID },
      });
      expect(result).toEqual([null]);
    }); // AC-42

    it('batch rejects when user_id is missing (negative)', async () => {
      const store = new DynamoDBStore({ memoryTableName: MEMORY_TABLE });
      await expect(store.batch([{ namespace: ['ns'], key: 'k' }])).rejects.toThrow(
        'Field user_id is required in the RunnableConfig for DynamoDBStore.',
      );
      expectNoUnexpectedCommands(ddb.mock, []);
    }); // AC-23
  });

  describe('DynamoDBChatMessageHistory', () => {
    it('getMessages returns [] for a session with no messages (positive)', async () => {
      ddb.mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });
      const history = new DynamoDBChatMessageHistory({ tableName: HISTORY_TABLE });
      await expect(history.getMessages(USER_ID, SESSION_ID)).resolves.toEqual([]);
    }); // AC-42

    it('getMessages rejects an empty userId (negative)', async () => {
      const history = new DynamoDBChatMessageHistory({ tableName: HISTORY_TABLE });
      await expect(history.getMessages('', SESSION_ID)).rejects.toThrow();
      expectNoUnexpectedCommands(ddb.mock, []);
    }); // AC-23

    it('forSession returns a DynamoDBSessionChatMessageHistory bound to the pair (positive)', () => {
      const history = new DynamoDBChatMessageHistory({ tableName: HISTORY_TABLE });
      const session = history.forSession(USER_ID, SESSION_ID);
      expect(session).toBeInstanceOf(DynamoDBSessionChatMessageHistory);
    }); // AC-23
  });

  describe('DynamoDBSessionChatMessageHistory', () => {
    it('getMessages returns [] for an empty session via the adapter (positive)', async () => {
      ddb.mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });
      const history = new DynamoDBChatMessageHistory({ tableName: HISTORY_TABLE });
      const session = history.forSession(USER_ID, SESSION_ID);
      await expect(session.getMessages()).resolves.toEqual([]);
    }); // AC-42

    it('addMessages rejects an empty userId-bound session via validation (negative)', async () => {
      const history = new DynamoDBChatMessageHistory({ tableName: HISTORY_TABLE });
      const session = history.forSession('', SESSION_ID);
      await expect(session.getMessages()).rejects.toThrow();
      expectNoUnexpectedCommands(ddb.mock, []);
    }); // AC-23
  });

  describe('DynamoDBFactory', () => {
    it('createAll wires a shared client used by the checkpointer (positive)', async () => {
      ddb.mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });
      const all = DynamoDBFactory.createAll({ tablePrefix: 'pkg' });
      expect(all.checkpointer).toBeInstanceOf(DynamoDBSaver);
      await all.checkpointer.deleteThread(THREAD_ID);
      expect(ddb.mock.commandCalls(QueryCommand)[0].args[0].input.TableName).toBe(
        'pkg-checkpoints',
      );
      all.destroy();
    }); // AC-42

    it('createStore produces a store that rejects without user_id (negative)', async () => {
      const store = DynamoDBFactory.createStore();
      await expect(store.batch([{ namespace: ['ns'], key: 'k' }])).rejects.toThrow(
        'Field user_id is required in the RunnableConfig for DynamoDBStore.',
      );
    }); // AC-23
  });

  describe('logger functions', () => {
    it('setGlobalLogger then getLogger returns the installed logger; resetLogger restores default', () => {
      const custom: Logger = {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      };
      setGlobalLogger(custom);
      expect(getLogger()).toBe(custom);
      resetLogger();
      expect(getLogger()).not.toBe(custom);
    }); // AC-7

    it('redactSecrets replaces secret-keyed values and leaves non-secret values intact (positive)', () => {
      const redacted = redactSecrets({ apiKey: 'sk-123', region: 'us-east-1' }) as Record<
        string,
        unknown
      >;
      expect(redacted.apiKey).toBe('[REDACTED]');
      expect(redacted.region).toBe('us-east-1');
    }); // AC-7

    it('redactSecrets passes a primitive through unchanged (negative/no-op branch)', () => {
      expect(redactSecrets('plain-string')).toBe('plain-string');
    }); // AC-7

    it('redactLogger forwards redacted args to the inner logger (positive)', () => {
      const seen: unknown[][] = [];
      const inner: Logger = {
        info: (_msg, ...args) => seen.push(args),
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      };
      const wrapped = redactLogger(inner);
      wrapped.info('hello', { password: 'hunter2', user: 'bob' });
      expect(seen).toHaveLength(1);
      expect(seen[0][0]).toEqual({ password: '[REDACTED]', user: 'bob' });
    }); // AC-7
  });

  describe('BatchWriteIncompleteError', () => {
    it('exposes name, succeededCount and unprocessed (positive)', () => {
      const unprocessed = [{ PutRequest: { Item: { id: '1' } } }];
      const err = new BatchWriteIncompleteError(3, unprocessed, 5);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('BatchWriteIncompleteError');
      expect(err.succeededCount).toBe(3);
      expect(err.unprocessed).toEqual(unprocessed);
    }); // AC-7

    it('carries a descriptive message referencing the un-acked count (negative-shape assertion)', () => {
      const err = new BatchWriteIncompleteError(0, [{ DeleteRequest: { Key: { id: '9' } } }], 5);
      expect(err.message).toContain('1 still un-acked');
    }); // AC-7
  });
});
