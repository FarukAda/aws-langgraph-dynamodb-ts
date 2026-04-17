import { BaseListChatMessageHistory } from '@langchain/core/chat_history';
import { HumanMessage } from '@langchain/core/messages';

import { DynamoDBChatMessageHistory } from '../../src';
import { DynamoDBSessionChatMessageHistory } from '../../src/history/session-adapter';
import { setupHistoryTest, type HistoryTestSetup } from '../shared/helpers/test-setup';

describe('DynamoDBSessionChatMessageHistory', () => {
  let setup: HistoryTestSetup;

  beforeEach(() => {
    setup = setupHistoryTest();
  });

  afterEach(() => {
    setup.cleanup();
  });

  it('is a BaseListChatMessageHistory so it works with RunnableWithMessageHistory', () => {
    const store = new DynamoDBChatMessageHistory({
      tableName: 'sessions',
      client: setup.client,
    });

    const session = store.forSession('user-1', 'session-1');

    expect(session).toBeInstanceOf(DynamoDBSessionChatMessageHistory);
    // eslint-disable-next-line no-instanceof/no-instanceof
    expect(session instanceof BaseListChatMessageHistory).toBe(true);
    expect(session.lc_namespace).toEqual(['langchain', 'stores', 'message', 'dynamodb']);
  });

  it('getMessages delegates to the underlying DynamoDB table', async () => {
    setup.ddbDocMock.onAnyCommand().resolvesOnce({
      Items: [
        {
          userId: 'user-1',
          sessionId: 'session-1#msg#000000',
          itemType: 'message',
          messageIndex: 0,
          message: {
            type: 'human',
            data: { content: 'hello', role: undefined, name: undefined, tool_call_id: undefined },
          },
        },
      ],
    });

    const store = new DynamoDBChatMessageHistory({ tableName: 'sessions', client: setup.client });
    const session = store.forSession('user-1', 'session-1');
    const messages = await session.getMessages();

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('hello');
  });

  it('addMessage writes via the same optimistic-counter path as the multi-session class', async () => {
    // Sequence: get metadata (empty) → transactWrite (success)
    setup.ddbDocMock.onAnyCommand().resolvesOnce({ Item: undefined }).resolvesOnce({});

    const store = new DynamoDBChatMessageHistory({ tableName: 'sessions', client: setup.client });
    const session = store.forSession('user-1', 'session-1');

    await expect(session.addMessage(new HumanMessage('hi'))).resolves.not.toThrow();
  });
});
