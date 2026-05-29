import { DeleteCommand, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { HumanMessage } from '@langchain/core/messages';

import { DynamoDBChatMessageHistory } from '../../../src/history/chat-message-history';
import { DynamoDBSessionChatMessageHistory } from '../../../src/history/session-adapter';
import { JSON_SERDE } from '../../../src/shared/codec/json-serde';
import { createStrictDocumentMock } from '../../shared/helpers/ddb-mock';

function history(client) {
  return new DynamoDBChatMessageHistory({ tableName: 'history', client, serde: JSON_SERDE });
}

describe('DynamoDBChatMessageHistory', () => {
  it('addMessage then getMessages round-trips through DynamoDB', async () => {
    const { client, mock } = createStrictDocumentMock();
    let stored;
    mock.on(GetCommand).callsFake(() => (stored ? { Item: stored } : {}));
    mock.on(PutCommand).callsFake((input) => {
      stored = input.Item;
      return {};
    });
    const h = history(client);
    await h.addMessage('sess-1', new HumanMessage('hello'));
    const messages = await h.getMessages('sess-1');
    expect(messages.map((m) => m.content)).toEqual(['hello']);
  });

  it('clear deletes the session', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({
      Item: { messages: { location: 'INLINE', serdeType: 'json', bytes: new Uint8Array() } },
    });
    mock.on(DeleteCommand).resolves({});
    await history(client).clear('sess-1');
    expect(mock.commandCalls(DeleteCommand)).toHaveLength(1);
  });

  it('listSessions scans for sessions', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(ScanCommand)
      .resolves({ Items: [{ sessionId: 's', messageCount: 1, createdAt: 'c', updatedAt: 'u' }] });
    const sessions = await history(client).listSessions();
    expect(sessions.map((s) => s.sessionId)).toEqual(['s']);
  });

  it('forSession returns a single-session adapter bound to the session', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    const adapter = history(client).forSession('sess-9');
    expect(adapter).toBeInstanceOf(DynamoDBSessionChatMessageHistory);
    await adapter.addMessage(new HumanMessage('hi'));
    expect(mock.commandCalls(PutCommand)[0].args[0].input.Item.PK).toBe('sess-9');
  });

  it('does not destroy an injected client but destroys an owned one', () => {
    const injected = createStrictDocumentMock();
    expect(() => history(injected.client).destroy()).not.toThrow();

    const destroy = jest.fn();
    const fake = { destroy, config: {}, middlewareStack: { clone: () => ({}) }, send: jest.fn() };
    const owned = new DynamoDBChatMessageHistory({
      tableName: 'history',
      clientConfig: { region: 'us-east-1' },
      createClient: () => fake as never,
    });
    owned.destroy();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
