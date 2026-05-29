/**
 * Unit tests for the DynamoDBChatMessageHistory orchestration class
 * (src/history/index.ts).
 *
 * This class is a thin facade: its constructor resolves a DynamoDB client via
 * the shared `resolveDynamoDBClient` seam, each public method threads the
 * configured `tableName` / `ttlDays` and the caller's `(userId, sessionId)` into
 * the matching history action, `forSession` binds a LangChain-compatible adapter,
 * and `destroy` releases the owned client.
 *
 * Because the facade owns no logic of its own beyond wiring, these tests assert
 * the observable contract end-to-end through the real actions: the EXACT
 * DynamoDB command class + full `.input` each public method produces (so a
 * mis-wired tableName/ttlDays/identity, a dropped option, or a swapped action
 * fails). Construction is exercised WITHOUT an injected client so the
 * `mockClient(DynamoDBDocumentClient)` interceptor still captures the commands —
 * this also pins the `ownsClient`/`destroy` lifecycle.
 *
 * Conventions: global frozen time (Date.now() === FROZEN_NOW_MS) and seeded RNG
 * come from jest setupFilesAfterEnv; deterministic values are asserted as
 * literal constants (never expect.any). The strict DDB mock REJECTS any command
 * a test did not stub.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';

import {
  DynamoDBChatMessageHistory,
  // Imported from the index re-export (not session-adapter) so the facade's
  // `export { ... } from './session-adapter'` line is exercised by coverage.
  DynamoDBSessionChatMessageHistory,
} from '../../../src/history/index';
import { HistoryValidationError } from '../../../src/history/utils/validation';
import { makeMessages, USER_ID, SESSION_ID } from '../../shared/fixtures/test-data';
import { preAbortedSignal } from '../../shared/helpers/abort';
import { FROZEN_NOW_MS, EXPECTED_TTL_30D } from '../../shared/helpers/frozen-time';
import {
  expectExactGetCommand,
  expectExactQueryCommand,
  expectExactTransactWriteCommand,
  expectNoUnexpectedCommands,
} from '../../shared/helpers/strict-ddb-assertions';
import { createStrictDdbMock, type StrictDdbMock } from '../../shared/mocks/dynamodb';

const TABLE = 'chat-history';

// The GetCommand input the read-before-write step builds (shared by add paths).
const EXPECTED_GET_INPUT = {
  TableName: TABLE,
  Key: { userId: USER_ID, sessionId: SESSION_ID },
  ConsistentRead: true,
  ProjectionExpression: 'messageCount',
};

describe('DynamoDBChatMessageHistory (orchestration facade)', () => {
  let ddb: StrictDdbMock;

  beforeEach(() => {
    ddb = createStrictDdbMock();
  });

  afterEach(() => {
    ddb.mock.restore();
  });

  /**
   * Construct WITHOUT an injected client so `resolveDynamoDBClient` builds a real
   * DynamoDBClient + DynamoDBDocument. The global mockClient(DynamoDBDocumentClient)
   * still intercepts every command at the send layer. This is the construction
   * mode the task pins (ownsClient === true).
   */
  function makeHistory(opts: { ttlDays?: number } = {}): DynamoDBChatMessageHistory {
    return new DynamoDBChatMessageHistory({ tableName: TABLE, ttlDays: opts.ttlDays });
  }

  describe('constructor + client resolution', () => {
    it('builds and owns its own DynamoDBClient when no client is injected (clientConfig default path)', () => {
      // If construction threw, resolveDynamoDBClient wiring is broken. The owned
      // client is asserted indirectly via destroy() below; here we only prove the
      // facade constructs against the intercepted DocumentClient.
      const history = makeHistory();
      expect(history).toBeInstanceOf(DynamoDBChatMessageHistory);
    });

    it('does NOT own (and never destroys) an externally injected DynamoDBDocument client', () => {
      // Injected client: ownsClient === false, so destroy() must be a no-op.
      const destroySpy = jest.spyOn(DynamoDBClient.prototype, 'destroy');
      const injected = new DynamoDBClient({});
      const docClient =
        // The library wraps with DynamoDBDocument.from; we hand it a DocumentClient
        // shim the mock already intercepts.
        ddb.mock as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocument;
      const history = new DynamoDBChatMessageHistory({ tableName: TABLE, client: docClient });
      destroySpy.mockClear();

      history.destroy();

      // ownsClient === false → underlying client.destroy must not be called.
      expect(destroySpy).not.toHaveBeenCalled();
      injected.destroy();
      destroySpy.mockRestore();
    });
  });

  describe('destroy()', () => {
    it('destroys the owned underlying DynamoDBClient exactly once', () => {
      const destroySpy = jest
        .spyOn(DynamoDBClient.prototype, 'destroy')
        .mockImplementation(() => undefined);
      const history = makeHistory();
      destroySpy.mockClear();

      history.destroy();

      expect(destroySpy).toHaveBeenCalledTimes(1);
      destroySpy.mockRestore();
    });
  });

  describe('getMessages', () => {
    it('threads userId/sessionId/table into a QueryCommand and maps stored items to BaseMessages', async () => {
      const stored = makeMessages(2);
      ddb.mock.on(QueryCommand).resolves({
        Items: [
          {
            userId: USER_ID,
            sessionId: `${SESSION_ID}#msg#000000`,
            itemType: 'message',
            messageIndex: 0,
            message: stored[0].toDict(),
          },
          {
            userId: USER_ID,
            sessionId: `${SESSION_ID}#msg#000001`,
            itemType: 'message',
            messageIndex: 1,
            message: stored[1].toDict(),
          },
        ],
      });

      const result = await makeHistory().getMessages(USER_ID, SESSION_ID);

      expectExactQueryCommand(ddb.mock, {
        TableName: TABLE,
        KeyConditionExpression: 'userId = :userId AND begins_with(sessionId, :prefix)',
        ExpressionAttributeValues: {
          ':userId': USER_ID,
          ':prefix': `${SESSION_ID}#msg#`,
        },
        ExclusiveStartKey: undefined,
      });
      expect(result.map((m) => m.content)).toEqual(['message-0', 'message-1']);
      expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
    });

    it('returns an empty array (no mapping) when the session has no message items', async () => {
      ddb.mock.on(QueryCommand).resolves({ Items: [] });

      const result = await makeHistory().getMessages(USER_ID, SESSION_ID);

      expect(result).toEqual([]);
      expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
    });

    it('forwards the AbortSignal so an already-aborted call rejects with zero DDB commands', async () => {
      const reason = new Error('cancelled-get');
      ddb.mock.on(QueryCommand).resolves({ Items: [] });

      await expect(
        makeHistory().getMessages(USER_ID, SESSION_ID, { signal: preAbortedSignal(reason) }),
      ).rejects.toBe(reason);

      expectNoUnexpectedCommands(ddb.mock, []);
    });

    it('surfaces the action validation rejection for an empty userId before any DDB command', async () => {
      await expect(makeHistory().getMessages('', SESSION_ID)).rejects.toThrow(
        'User ID cannot be empty',
      );
      expectNoUnexpectedCommands(ddb.mock, []);
    });
  });

  describe('addMessage', () => {
    it('writes the single-message Put + metadata Update transaction for a brand-new session (no ttl)', async () => {
      ddb.mock.on(GetCommand).resolves({}); // new session: no Item
      ddb.mock.on(TransactWriteCommand).resolves({});

      const [message] = makeMessages(1);
      await makeHistory().addMessage(USER_ID, SESSION_ID, message);

      expectExactGetCommand(ddb.mock, EXPECTED_GET_INPUT);
      expectExactTransactWriteCommand(ddb.mock, {
        TransactItems: [
          {
            Put: {
              TableName: TABLE,
              Item: {
                userId: USER_ID,
                sessionId: `${SESSION_ID}#msg#000000`,
                itemType: 'message',
                messageIndex: 0,
                message: message.toDict(),
              },
            },
          },
          {
            Update: {
              TableName: TABLE,
              Key: { userId: USER_ID, sessionId: SESSION_ID },
              UpdateExpression:
                'SET updatedAt = :updatedAt, itemType = :itemType, messageCount = :newCount, title = if_not_exists(title, :title), createdAt = if_not_exists(createdAt, :createdAt)',
              ConditionExpression: 'attribute_not_exists(messageCount)',
              ExpressionAttributeValues: {
                ':updatedAt': FROZEN_NOW_MS,
                ':createdAt': FROZEN_NOW_MS,
                ':newCount': 1,
                ':itemType': 'metadata',
                ':title': 'message-0',
              },
            },
          },
        ],
      });
      expectNoUnexpectedCommands(ddb.mock, [GetCommand, TransactWriteCommand]);
    });

    it('passes an explicit title through verbatim instead of auto-generating from the message', async () => {
      ddb.mock.on(GetCommand).resolves({});
      ddb.mock.on(TransactWriteCommand).resolves({});

      const [message] = makeMessages(1);
      await makeHistory().addMessage(USER_ID, SESSION_ID, message, 'Custom Title');

      const call = ddb.mock.commandCalls(TransactWriteCommand)[0];
      const update = (
        call.args[0].input as {
          TransactItems: Array<{ Update?: { ExpressionAttributeValues: Record<string, unknown> } }>;
        }
      ).TransactItems[1].Update!;
      expect(update.ExpressionAttributeValues[':title']).toBe('Custom Title');
    });
  });

  describe('addMessages', () => {
    it('threads ttlDays into per-message TTL and aliased #ttl metadata for a new session', async () => {
      ddb.mock.on(GetCommand).resolves({});
      ddb.mock.on(TransactWriteCommand).resolves({});

      const [message] = makeMessages(1);
      await makeHistory({ ttlDays: 30 }).addMessages(USER_ID, SESSION_ID, [message]);

      expectExactTransactWriteCommand(ddb.mock, {
        TransactItems: [
          {
            Put: {
              TableName: TABLE,
              Item: {
                userId: USER_ID,
                sessionId: `${SESSION_ID}#msg#000000`,
                itemType: 'message',
                messageIndex: 0,
                message: message.toDict(),
                ttl: EXPECTED_TTL_30D,
              },
            },
          },
          {
            Update: {
              TableName: TABLE,
              Key: { userId: USER_ID, sessionId: SESSION_ID },
              UpdateExpression:
                'SET updatedAt = :updatedAt, itemType = :itemType, messageCount = :newCount, title = if_not_exists(title, :title), createdAt = if_not_exists(createdAt, :createdAt), #ttl = :ttl',
              ConditionExpression: 'attribute_not_exists(messageCount)',
              ExpressionAttributeValues: {
                ':updatedAt': FROZEN_NOW_MS,
                ':createdAt': FROZEN_NOW_MS,
                ':newCount': 1,
                ':itemType': 'metadata',
                ':title': 'message-0',
                ':ttl': EXPECTED_TTL_30D,
              },
              ExpressionAttributeNames: { '#ttl': 'ttl' },
            },
          },
        ],
      });
      expectNoUnexpectedCommands(ddb.mock, [GetCommand, TransactWriteCommand]);
    });

    it('appends at the existing count using the optimistic messageCount = :expectedCount condition', async () => {
      ddb.mock.on(GetCommand).resolves({ Item: { messageCount: 2 } });
      ddb.mock.on(TransactWriteCommand).resolves({});

      const [message] = makeMessages(1);
      await makeHistory().addMessages(USER_ID, SESSION_ID, [message]);

      const call = ddb.mock.commandCalls(TransactWriteCommand)[0];
      const input = call.args[0].input as {
        TransactItems: Array<{
          Put?: { Item: { sessionId: string; messageIndex: number } };
          Update?: {
            ConditionExpression: string;
            ExpressionAttributeValues: Record<string, unknown>;
          };
        }>;
      };
      expect(input.TransactItems[0].Put!.Item.sessionId).toBe(`${SESSION_ID}#msg#000002`);
      expect(input.TransactItems[0].Put!.Item.messageIndex).toBe(2);
      expect(input.TransactItems[1].Update!.ConditionExpression).toBe(
        'messageCount = :expectedCount',
      );
      expect(input.TransactItems[1].Update!.ExpressionAttributeValues[':expectedCount']).toBe(2);
      expect(input.TransactItems[1].Update!.ExpressionAttributeValues[':newCount']).toBe(3);
    });

    it('re-reads and retries once on ConditionalCheckFailedException, then succeeds (optimistic-retry wiring)', async () => {
      ddb.mock.on(GetCommand).resolves({ Item: { messageCount: 0 } });
      ddb.mock
        .on(TransactWriteCommand)
        .rejectsOnce(new ConditionalCheckFailedException({ message: 'race', $metadata: {} }))
        .resolves({});

      await makeHistory().addMessages(USER_ID, SESSION_ID, makeMessages(1));

      // Retry re-reads: two Gets, two TransactWrites.
      expect(ddb.mock.commandCalls(GetCommand)).toHaveLength(2);
      expect(ddb.mock.commandCalls(TransactWriteCommand)).toHaveLength(2);
      expectNoUnexpectedCommands(ddb.mock, [GetCommand, TransactWriteCommand]);
    });

    it('rejects with HistoryValidationError and issues zero DDB commands on an empty messages array', async () => {
      await expect(makeHistory().addMessages(USER_ID, SESSION_ID, [])).rejects.toBeInstanceOf(
        HistoryValidationError,
      );
      expectNoUnexpectedCommands(ddb.mock, []);
    });

    it('forwards the AbortSignal so an already-aborted add rejects with zero DDB commands', async () => {
      const reason = new Error('cancelled-add');
      ddb.mock.on(GetCommand).resolves({});
      ddb.mock.on(TransactWriteCommand).resolves({});

      await expect(
        makeHistory().addMessages(USER_ID, SESSION_ID, makeMessages(1), undefined, {
          signal: preAbortedSignal(reason),
        }),
      ).rejects.toBe(reason);

      expectNoUnexpectedCommands(ddb.mock, []);
    });
  });

  describe('clear', () => {
    it('queries message keys then batch-deletes the metadata key first, then each message key', async () => {
      const msgKey0 = { userId: USER_ID, sessionId: `${SESSION_ID}#msg#000000` };
      ddb.mock.on(QueryCommand).resolves({ Items: [msgKey0] });
      ddb.mock.on(BatchWriteCommand).resolves({});

      await makeHistory().clear(USER_ID, SESSION_ID);

      expectExactQueryCommand(ddb.mock, {
        TableName: TABLE,
        KeyConditionExpression: 'userId = :userId AND begins_with(sessionId, :prefix)',
        ExpressionAttributeValues: {
          ':userId': USER_ID,
          ':prefix': `${SESSION_ID}#msg#`,
        },
        ProjectionExpression: 'userId, sessionId',
        ExclusiveStartKey: undefined,
      });
      const batchCalls = ddb.mock.commandCalls(BatchWriteCommand);
      expect(batchCalls).toHaveLength(1);
      expect(batchCalls[0].args[0].input).toEqual({
        RequestItems: {
          [TABLE]: [
            { DeleteRequest: { Key: { userId: USER_ID, sessionId: SESSION_ID } } },
            { DeleteRequest: { Key: msgKey0 } },
          ],
        },
      });
      expectNoUnexpectedCommands(ddb.mock, [QueryCommand, BatchWriteCommand]);
    });

    it('forwards the AbortSignal so an already-aborted clear rejects with zero DDB commands', async () => {
      const reason = new Error('cancelled-clear');
      ddb.mock.on(QueryCommand).resolves({ Items: [] });
      ddb.mock.on(BatchWriteCommand).resolves({});

      await expect(
        makeHistory().clear(USER_ID, SESSION_ID, { signal: preAbortedSignal(reason) }),
      ).rejects.toBe(reason);

      expectNoUnexpectedCommands(ddb.mock, []);
    });
  });

  describe('listSessions', () => {
    it('queries metadata items with the projection and returns them sorted by updatedAt DESC', async () => {
      ddb.mock.on(QueryCommand).resolves({
        Items: [
          {
            sessionId: 'older',
            title: 'Older',
            createdAt: 1_000,
            updatedAt: 1_700_000_000_000,
            messageCount: 1,
          },
          {
            sessionId: 'newer',
            title: 'Newer',
            createdAt: 2_000,
            updatedAt: 1_700_000_500_000,
            messageCount: 2,
          },
        ],
      });

      const result = await makeHistory().listSessions(USER_ID);

      expectExactQueryCommand(ddb.mock, {
        TableName: TABLE,
        KeyConditionExpression: 'userId = :userId',
        FilterExpression: 'itemType = :metadata',
        ExpressionAttributeValues: {
          ':userId': USER_ID,
          ':metadata': 'metadata',
        },
        ProjectionExpression: 'sessionId, title, createdAt, updatedAt, messageCount',
        ExclusiveStartKey: undefined,
      });
      expect(result.map((s) => s.sessionId)).toEqual(['newer', 'older']);
      expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
    });

    it('applies the limit to the sorted result, keeping only the most recent N sessions', async () => {
      ddb.mock.on(QueryCommand).resolves({
        Items: [
          { sessionId: 'a', title: 'A', createdAt: 1, updatedAt: 100, messageCount: 1 },
          { sessionId: 'b', title: 'B', createdAt: 2, updatedAt: 300, messageCount: 1 },
          { sessionId: 'c', title: 'C', createdAt: 3, updatedAt: 200, messageCount: 1 },
        ],
      });

      const result = await makeHistory().listSessions(USER_ID, 2);

      expect(result.map((s) => s.sessionId)).toEqual(['b', 'c']);
    });

    it('surfaces the validateLimit rejection for a non-positive limit before any DDB command', async () => {
      await expect(makeHistory().listSessions(USER_ID, 0)).rejects.toThrow();
      expectNoUnexpectedCommands(ddb.mock, []);
    });
  });

  describe('forSession', () => {
    it('binds a (userId, sessionId)-scoped LangChain adapter that threads identity into its QueryCommand', async () => {
      ddb.mock.on(QueryCommand).resolves({ Items: [] });

      const adapter = makeHistory().forSession(USER_ID, SESSION_ID);
      expect(adapter).toBeInstanceOf(DynamoDBSessionChatMessageHistory);
      expect(adapter.lc_namespace).toEqual(['langchain', 'stores', 'message', 'dynamodb']);

      const messages = await adapter.getMessages();
      expect(messages).toEqual([]);

      const calls = ddb.mock.commandCalls(QueryCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input).toMatchObject({
        TableName: TABLE,
        KeyConditionExpression: 'userId = :userId AND begins_with(sessionId, :prefix)',
        ExpressionAttributeValues: {
          ':userId': USER_ID,
          ':prefix': `${SESSION_ID}#msg#`,
        },
      });
    });

    it('propagates the configured ttlDays into the adapter so its writes stamp TTL', async () => {
      ddb.mock.on(GetCommand).resolves({});
      ddb.mock.on(TransactWriteCommand).resolves({});

      const adapter = makeHistory({ ttlDays: 30 }).forSession(USER_ID, SESSION_ID);
      await adapter.addMessages(makeMessages(1));

      const call = ddb.mock.commandCalls(TransactWriteCommand)[0];
      const input = call.args[0].input as {
        TransactItems: Array<{ Put?: { Item: { ttl?: number } } }>;
      };
      expect(input.TransactItems[0].Put!.Item.ttl).toBe(EXPECTED_TTL_30D);
    });
  });
});
