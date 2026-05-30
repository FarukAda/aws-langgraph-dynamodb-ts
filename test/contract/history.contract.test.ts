import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BaseListChatMessageHistory } from '@langchain/core/chat_history';
import { AIMessage, HumanMessage } from '@langchain/core/messages';

import { DynamoDBChatMessageHistory } from '../../src/index';
import { createTable, DDB_LOCAL_CONFIG, deleteTable } from '../integration/helpers/ddb-local';

const tableName = 'history-contract';
const admin = new DynamoDBClient(DDB_LOCAL_CONFIG);
let history: DynamoDBChatMessageHistory;

beforeAll(async () => {
  await createTable(admin, tableName);
  history = new DynamoDBChatMessageHistory({ tableName, clientConfig: DDB_LOCAL_CONFIG });
});

afterAll(async () => {
  history.destroy();
  await deleteTable(admin, tableName);
  admin.destroy();
});

describe('BaseListChatMessageHistory contract conformance', () => {
  it('forSession is a BaseListChatMessageHistory whose methods round-trip', async () => {
    const session = history.forSession('contract-1');
    expect(session).toBeInstanceOf(BaseListChatMessageHistory);

    await session.addMessage(new HumanMessage('a'));
    await session.addMessages([new AIMessage('b'), new HumanMessage('c')]);
    const messages = await session.getMessages();
    expect(messages.map((m) => m.content)).toEqual(['a', 'b', 'c']);

    await session.clear();
    expect(await session.getMessages()).toEqual([]);
  });
});
