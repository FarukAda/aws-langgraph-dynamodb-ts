/**
 * Strict unit tests for DynamoDBFactory (src/factory.ts).
 *
 * Characterizes the existing factory: default table-name resolution, option
 * forwarding, the createAll() shared-client wiring (REQ-43..48 client-factory
 * seam) and its destroy() teardown, plus a negative path (a store produced by
 * the factory still surfaces the documented user_id error).
 *
 * The shared DDB client built by the factory is intercepted by
 * aws-sdk-client-mock (mockClient(DynamoDBDocumentClient) patches every
 * DynamoDBDocumentClient instance), so factory-built instances drive the strict
 * mock without needing a pre-built client injected.
 *
 * AC-38 note: the planned `createClient` injection seam (REQ-46) is asserted in
 * the dedicated block below. If the seam has not yet been added to source these
 * it()s fail to compile/run — that is the expected failing-test state for this
 * additive seam; the default-equivalence is asserted via the no-arg createAll
 * path which must remain byte-identical.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

import { DynamoDBFactory } from '../../src/factory';
import { DynamoDBSaver, DynamoDBStore, DynamoDBChatMessageHistory } from '../../src/index';
import { THREAD_ID, USER_ID } from '../shared/fixtures/test-data';
import {
  expectExactQueryCommand,
  expectNoUnexpectedCommands,
} from '../shared/helpers/strict-ddb-assertions';
import { createStrictDdbMock, type StrictDdbMock } from '../shared/mocks/dynamodb';

describe('DynamoDBFactory', () => {
  let ddb: StrictDdbMock;

  beforeEach(() => {
    ddb = createStrictDdbMock();
  });

  afterEach(() => {
    ddb.mock.restore();
  });

  describe('createSaver', () => {
    it('defaults the checkpoints table name to "langgraph-checkpoints" (observed via deleteThread Query)', async () => {
      ddb.mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });
      const saver = DynamoDBFactory.createSaver();
      expect(saver).toBeInstanceOf(DynamoDBSaver);

      await saver.deleteThread(THREAD_ID);

      expectExactQueryCommand(ddb.mock, {
        TableName: 'langgraph-checkpoints',
        KeyConditionExpression: 'thread_id = :thread_id',
        ExpressionAttributeValues: { ':thread_id': THREAD_ID },
        ExclusiveStartKey: undefined,
      });
      expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
    }); // AC-7

    it('honors a custom checkpointsTableName override (observed via deleteThread Query)', async () => {
      ddb.mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });
      const saver = DynamoDBFactory.createSaver({ checkpointsTableName: 'custom-checkpoints' });

      await saver.deleteThread(THREAD_ID);

      expect(ddb.mock.commandCalls(QueryCommand)[0].args[0].input.TableName).toBe(
        'custom-checkpoints',
      );
    }); // AC-7
  });

  describe('createStore', () => {
    it('creates a DynamoDBStore and surfaces the documented user_id error on batch without user_id', async () => {
      const store = DynamoDBFactory.createStore();
      expect(store).toBeInstanceOf(DynamoDBStore);

      await expect(store.batch([{ namespace: ['ns'], key: 'k' }])).rejects.toThrow(
        'Field user_id is required in the RunnableConfig for DynamoDBStore.',
      );
      expectNoUnexpectedCommands(ddb.mock, []);
    }); // AC-7

    it('defaults the memory table name to "langgraph-memory" (observed via a get operation)', async () => {
      ddb.mock.on(GetCommand).resolves({ Item: undefined });
      const store = DynamoDBFactory.createStore();

      const result = await store.batch([{ namespace: ['ns'], key: 'k' }], {
        configurable: { user_id: USER_ID },
      });
      expect(result).toEqual([null]);
      expect(ddb.mock.commandCalls(GetCommand)[0].args[0].input.TableName).toBe('langgraph-memory');
    }); // AC-7
  });

  describe('createChatMessageHistory', () => {
    it('defaults the table name to "langgraph-chat-history" (observed via getMessages Query)', async () => {
      ddb.mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });
      const history = DynamoDBFactory.createChatMessageHistory();
      expect(history).toBeInstanceOf(DynamoDBChatMessageHistory);

      const messages = await history.getMessages(USER_ID, 'session-1');
      expect(messages).toEqual([]);
      expect(ddb.mock.commandCalls(QueryCommand)[0].args[0].input.TableName).toBe(
        'langgraph-chat-history',
      );
    }); // AC-7
  });

  describe('createAll', () => {
    it('returns all three instances plus a destroy() and applies the table prefix to the shared client', async () => {
      ddb.mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });
      const all = DynamoDBFactory.createAll({ tablePrefix: 'my-app' });

      expect(all.checkpointer).toBeInstanceOf(DynamoDBSaver);
      expect(all.store).toBeInstanceOf(DynamoDBStore);
      expect(all.chatHistory).toBeInstanceOf(DynamoDBChatMessageHistory);
      expect(typeof all.destroy).toBe('function');

      // The shared client built by createAll is the one the checkpointer uses.
      await all.checkpointer.deleteThread(THREAD_ID);
      expect(ddb.mock.commandCalls(QueryCommand)[0].args[0].input.TableName).toBe(
        'my-app-checkpoints',
      );
    }); // AC-7

    it('destroy() is idempotent and does not throw on a double call (documented double-destroy guard)', () => {
      const all = DynamoDBFactory.createAll();
      // First call tears down; second call is a no-op via the `destroyed` guard.
      all.destroy();
      let secondCallThrew = false;
      try {
        all.destroy();
      } catch {
        secondCallThrew = true;
      }
      expect(secondCallThrew).toBe(false);
    }); // AC-7
  });

  describe('client-factory seam (REQ-46 / AC-38)', () => {
    it('createAll uses an injected createClient factory while preserving the no-arg default behavior', async () => {
      ddb.mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });

      let createdConfigs = 0;
      const all = DynamoDBFactory.createAll({
        tablePrefix: 'seam-app',
        // Planned seam shape (REQ-46): a DynamoDB client factory injected here.
        createClient: (cfg) => {
          createdConfigs += 1;
          // Defer to the real ctor so behavior is byte-identical to the default.
          return new DynamoDBClient(cfg ?? {}) as never;
        },
      } as unknown as Parameters<typeof DynamoDBFactory.createAll>[0]);

      // Exactly one shared client is built for all three modules.
      expect(createdConfigs).toBe(1);

      await all.checkpointer.deleteThread(THREAD_ID);
      expect(ddb.mock.commandCalls(QueryCommand)[0].args[0].input.TableName).toBe(
        'seam-app-checkpoints',
      );
      all.destroy();
    }); // AC-38
  });
});
