import { BatchWriteCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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
    let written: unknown[] = [];
    mock.on(BatchWriteCommand).callsFake((input) => {
      written = input.RequestItems.history.map(
        (w: { PutRequest: { Item: unknown } }) => w.PutRequest.Item,
      );
      return { UnprocessedItems: {} };
    });
    mock.on(UpdateCommand).resolves({});
    mock.on(QueryCommand).callsFake(() => ({ Items: written }));
    const h = history(client);
    await h.addMessage('sess-1', new HumanMessage('hello'));
    const messages = await h.getMessages('sess-1');
    expect(messages.map((m) => m.content)).toEqual(['hello']);
  });

  it('clear deletes every item in the session partition', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({
      Items: [
        {
          PK: 'sess-1',
          SK: 'MSG#01A',
          message: { location: 'INLINE', serdeType: 'json', bytes: new Uint8Array() },
        },
        { PK: 'sess-1', SK: 'SESSION' },
      ],
    });
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    await history(client).clear('sess-1');
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(1);
  });

  it('listSessions scans for sessions', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({
      Items: [
        { PK: 's', SK: 'SESSION', sessionId: 's', messageCount: 1, createdAt: 'c', updatedAt: 'u' },
      ],
    });
    const sessions = await history(client).listSessions();
    expect(sessions.map((s) => s.sessionId)).toEqual(['s']);
  });

  it('forSession returns a single-session adapter bound to the session', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    mock.on(UpdateCommand).resolves({});
    const adapter = history(client).forSession('sess-9');
    expect(adapter).toBeInstanceOf(DynamoDBSessionChatMessageHistory);
    await adapter.addMessage(new HumanMessage('hi'));
    const item =
      mock.commandCalls(BatchWriteCommand)[0].args[0].input.RequestItems.history[0].PutRequest.Item;
    expect(item.PK).toBe('sess-9');
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
