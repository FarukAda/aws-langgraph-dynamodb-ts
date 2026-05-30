import { HumanMessage } from '@langchain/core/messages';

import { DynamoDBSessionChatMessageHistory } from '../../../src/history/session-adapter';

function backend() {
  return {
    getMessages: jest.fn().mockResolvedValue([]),
    addMessages: jest.fn().mockResolvedValue(undefined),
    clear: jest.fn().mockResolvedValue(undefined),
  };
}

describe('DynamoDBSessionChatMessageHistory', () => {
  it('delegates every operation to the backend with its bound session id', async () => {
    const b = backend();
    const history = new DynamoDBSessionChatMessageHistory(b, 'sess-7');
    const message = new HumanMessage('hi');

    await history.getMessages();
    await history.addMessage(message);
    await history.addMessages([message, message]);
    await history.clear();

    expect(b.getMessages).toHaveBeenCalledWith('sess-7');
    expect(b.addMessages).toHaveBeenNthCalledWith(1, 'sess-7', [message]);
    expect(b.addMessages).toHaveBeenNthCalledWith(2, 'sess-7', [message, message]);
    expect(b.clear).toHaveBeenCalledWith('sess-7');
  });

  it('declares a LangChain namespace so it is a valid message history', () => {
    const history = new DynamoDBSessionChatMessageHistory(backend(), 's');
    expect(history.lc_namespace).toEqual(['langchain', 'stores', 'message', 'dynamodb']);
  });
});
