/**
 * Unit tests for src/history/session-adapter.ts.
 *
 * Pinned to the REAL source surface (resolves all prior TODOs):
 *   export class DynamoDBSessionChatMessageHistory extends BaseListChatMessageHistory {
 *     constructor(params: { client, tableName, userId, sessionId, ttlDays? });
 *     getMessages(): Promise<BaseMessage[]>;
 *     addMessage(message): Promise<void>;
 *     addMessages(messages): Promise<void>;
 *     clear(): Promise<void>;
 *     lc_namespace = ['langchain','stores','message','dynamodb'];
 *   }
 *
 * There are NO standalone sessionMetadataToItem / itemToSessionMetadata exports
 * (the earlier draft invented them). The adapter is a thin facade that closes
 * over a fixed (userId, sessionId) and delegates to the history actions. So the
 * adapter's observable contract is: it threads the constructed identity into the
 * underlying DynamoDB commands, and surfaces the actions' validation rejections.
 *
 * Strategy:
 *   - Positive: getMessages() issues a QueryCommand whose KeyConditionExpression
 *     and ExpressionAttributeValues carry the constructed userId/sessionId and
 *     the table name (pinned: 'userId = :userId AND begins_with(sessionId, :prefix)'
 *     with :prefix === `${sessionId}#msg#`). We assert identity threading via
 *     toMatchObject (the full input shape is the action's contract, tested there).
 *   - Negative: an invalid userId/sessionId rejects with a HistoryValidationError
 *     BEFORE any DynamoDB command is sent (zero DDB calls — strict mock).
 *
 * AWS is mocked with aws-sdk-client-mock: the shared strict mock globally mocks
 * DynamoDBDocumentClient, so a real DynamoDBDocument.from(new DynamoDBClient({}))
 * passed to the adapter is intercepted. We never jest.mock('@aws-sdk/...').
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { DynamoDBSessionChatMessageHistory } from '../../../src/history/session-adapter';
import { HistoryValidationError } from '../../../src/history/utils/validation';
import { USER_ID, SESSION_ID, makeBaseMessage } from '../../shared/fixtures/test-data';
import { setupStrictTest } from '../../shared/helpers/test-setup';

const TABLE_NAME = 'chat-history';

describe('session-adapter (DynamoDBSessionChatMessageHistory)', () => {
  let handles: ReturnType<typeof setupStrictTest>;
  let docClient: DynamoDBDocument;

  beforeEach(() => {
    handles = setupStrictTest();
    // Intercepted by the global mockClient(DynamoDBDocumentClient) in the strict mock.
    docClient = DynamoDBDocument.from(new DynamoDBClient({ region: 'us-east-1' }));
  });

  afterEach(() => {
    docClient.destroy();
    handles.restore();
  });

  function makeAdapter(
    overrides: Partial<{ userId: string; sessionId: string; ttlDays: number }> = {},
  ): DynamoDBSessionChatMessageHistory {
    return new DynamoDBSessionChatMessageHistory({
      client: docClient,
      tableName: TABLE_NAME,
      userId: overrides.userId ?? USER_ID,
      sessionId: overrides.sessionId ?? SESSION_ID,
      ttlDays: overrides.ttlDays,
    });
  }

  describe('lc_namespace (LangChain contract)', () => {
    it('exposes the dynamodb message-store namespace', () => {
      const adapter = makeAdapter();
      expect(adapter.lc_namespace).toEqual(['langchain', 'stores', 'message', 'dynamodb']);
    }); // AC-7
  });

  describe('getMessages (positive — identity threading)', () => {
    it('queries with the constructed userId/sessionId/table and returns the mapped messages', async () => {
      handles.ddb.mock.on(QueryCommand).resolves({ Items: [] });

      const adapter = makeAdapter();
      const messages = await adapter.getMessages();

      expect(messages).toEqual([]);
      const calls = handles.ddb.mock.commandCalls(QueryCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input).toMatchObject({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'userId = :userId AND begins_with(sessionId, :prefix)',
        ExpressionAttributeValues: {
          ':userId': USER_ID,
          ':prefix': `${SESSION_ID}#msg#`,
        },
      });
    }); // AC-7
  });

  describe('getMessages (negative — validation short-circuit, zero DDB calls)', () => {
    it('rejects with HistoryValidationError and sends no DynamoDB command for an empty userId', async () => {
      const adapter = makeAdapter({ userId: '' });
      await expect(adapter.getMessages()).rejects.toBeInstanceOf(HistoryValidationError);
      expect(handles.ddb.mock.calls()).toHaveLength(0);
    }); // AC-7

    it('rejects with HistoryValidationError and sends no DynamoDB command for a sessionId containing "#"', async () => {
      const adapter = makeAdapter({ sessionId: 'bad#session' });
      await expect(adapter.getMessages()).rejects.toBeInstanceOf(HistoryValidationError);
      expect(handles.ddb.mock.calls()).toHaveLength(0);
    }); // AC-7
  });

  describe('addMessage (negative — validation short-circuit)', () => {
    it('rejects with HistoryValidationError and sends no DynamoDB command for an invalid userId', async () => {
      const adapter = makeAdapter({ userId: 'user#bad' });
      await expect(adapter.addMessage(makeBaseMessage({ content: 'hi' }))).rejects.toBeInstanceOf(
        HistoryValidationError,
      );
      expect(handles.ddb.mock.calls()).toHaveLength(0);
    }); // AC-7
  });

  describe('clear (negative — validation short-circuit)', () => {
    it('rejects with HistoryValidationError and sends no DynamoDB command for an invalid sessionId', async () => {
      const adapter = makeAdapter({ sessionId: '' });
      await expect(adapter.clear()).rejects.toBeInstanceOf(HistoryValidationError);
      expect(handles.ddb.mock.calls()).toHaveLength(0);
    }); // AC-7
  });
});
