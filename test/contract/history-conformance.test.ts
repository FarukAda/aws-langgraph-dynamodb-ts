import {
  BatchWriteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
/**
 * CONTRACT tier — chat-message-history vs. LangChain's BaseListChatMessageHistory
 * (REQ-28 / AC-24).
 *
 * The session-bound adapter returned by `DynamoDBChatMessageHistory.forSession`
 * is the `BaseListChatMessageHistory`-compatible surface a LangChain consumer
 * wires into a chain. This file proves that adapter satisfies the upstream
 * abstract contract — `getMessages()`, `addMessage(message)`, `addMessages(
 * messages)`, `clear()`, plus the convenience `addUserMessage`/`addAIMessage`
 * provided by the base — in both shape and behavior against the strict
 * aws-sdk-client-mock (no real DynamoDB). The upstream methods take NO ids; the
 * (userId, sessionId) pair is bound at `forSession`, which is the adaptation
 * under test.
 *
 * Mock-backed only: the history builds its own DynamoDBDocumentClient, which
 * mockClient(DynamoDBDocumentClient) intercepts at the command layer.
 */
import { BaseListChatMessageHistory } from '@langchain/core/chat_history';
import { AIMessage, HumanMessage, mapChatMessagesToStoredMessages } from '@langchain/core/messages';

import { DynamoDBChatMessageHistory } from '../../src/index';
import { USER_ID, SESSION_ID } from '../shared/fixtures/test-data';
import { expectNoUnexpectedCommands } from '../shared/helpers/strict-ddb-assertions';
import { createStrictDdbMock, type StrictDdbMock } from '../shared/mocks/dynamodb';

const HISTORY_TABLE = 'history-table';

function makeSession() {
  return new DynamoDBChatMessageHistory({ tableName: HISTORY_TABLE }).forSession(
    USER_ID,
    SESSION_ID,
  );
}

/** A stored DynamoDBMessageItem at the given index, as getMessages reads it back. */
function storedItem(index: number, message: HumanMessage | AIMessage) {
  const [stored] = mapChatMessagesToStoredMessages([message]);
  return {
    userId: USER_ID,
    sessionId: `${SESSION_ID}#msg#${String(index).padStart(6, '0')}`,
    itemType: 'message',
    messageIndex: index,
    message: stored,
  };
}

describe('DynamoDBSessionChatMessageHistory conformance to BaseListChatMessageHistory', () => {
  let ddb: StrictDdbMock;

  beforeEach(() => {
    ddb = createStrictDdbMock();
  });

  afterEach(() => {
    ddb.mock.restore();
  });

  it('is an instance of the upstream BaseListChatMessageHistory and exposes the full method set', () => {
    const session = makeSession();
    // Subclassing the upstream abstract class is the load-bearing contract: a
    // LangChain change to BaseListChatMessageHistory surfaces here.
    expect(session).toBeInstanceOf(BaseListChatMessageHistory);
    // Abstract members required by the upstream contract.
    expect(typeof session.getMessages).toBe('function');
    expect(typeof session.addMessage).toBe('function');
    expect(typeof session.addMessages).toBe('function');
    expect(typeof session.clear).toBe('function');
    // Convenience members the base provides; consumers may call these.
    expect(typeof session.addUserMessage).toBe('function');
    expect(typeof session.addAIMessage).toBe('function');
    // lc_namespace is part of the Serializable base contract.
    expect(Array.isArray(session.lc_namespace)).toBe(true);
  }); // AC-24

  it('addMessage(message) -> getMessages() round-trips through the mock and returns BaseMessage instances', async () => {
    // addMessage: read-before-write Get (empty == new session) + atomic TransactWrite.
    ddb.mock.on(GetCommand).resolves({});
    ddb.mock.on(TransactWriteCommand).resolves({});
    await makeSession().addMessage(new HumanMessage('hello world'));
    expect(ddb.mock.commandCalls(TransactWriteCommand)).toHaveLength(1);
    expectNoUnexpectedCommands(ddb.mock, [GetCommand, TransactWriteCommand]);

    // getMessages: a single SK-prefix Query returning the stored item.
    ddb.reset();
    ddb.mock.on(QueryCommand).resolves({ Items: [storedItem(0, new HumanMessage('hello world'))] });
    const messages = await makeSession().getMessages();
    // Upstream contract: getMessages resolves to BaseMessage[] (reconstructed instances).
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBeInstanceOf(HumanMessage);
    expect(messages[0].content).toBe('hello world');
    expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
  }); // AC-24

  it('addMessages(messages) honors the bulk-write contract with a single atomic TransactWrite', async () => {
    ddb.mock.on(GetCommand).resolves({});
    ddb.mock.on(TransactWriteCommand).resolves({});
    const result = await makeSession().addMessages([
      new HumanMessage('first'),
      new AIMessage('second'),
    ]);
    // Bulk addMessages resolves to void and performs one round-trip, not one-per-message.
    expect(result).toBeUndefined();
    expect(ddb.mock.commandCalls(TransactWriteCommand)).toHaveLength(1);
    expectNoUnexpectedCommands(ddb.mock, [GetCommand, TransactWriteCommand]);
  }); // AC-24

  it('getMessages() returns [] for an empty session, honoring the BaseMessage[] return contract', async () => {
    ddb.mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });
    const messages = await makeSession().getMessages();
    expect(messages).toEqual([]);
    expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
  }); // AC-24

  it('clear() removes the session via Query + BatchWrite and resolves to void per the contract', async () => {
    ddb.mock.on(QueryCommand).resolves({ Items: [] });
    ddb.mock.on(BatchWriteCommand).resolves({});
    const result = await makeSession().clear();
    expect(result).toBeUndefined();
    // Even an empty session deletes its metadata key via one BatchWrite.
    expect(ddb.mock.commandCalls(BatchWriteCommand)).toHaveLength(1);
    expectNoUnexpectedCommands(ddb.mock, [QueryCommand, BatchWriteCommand]);
  }); // AC-24

  it('getMessages() rejects an empty bound userId via validation before any DDB call (contract negative)', async () => {
    const badSession = new DynamoDBChatMessageHistory({ tableName: HISTORY_TABLE }).forSession(
      '',
      SESSION_ID,
    );
    await expect(badSession.getMessages()).rejects.toThrow();
    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-24
});
