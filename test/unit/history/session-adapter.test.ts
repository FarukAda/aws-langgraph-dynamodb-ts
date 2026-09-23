import { HumanMessage } from '@langchain/core/messages';

import { DynamoDBSessionChatMessageHistory } from '../../../src/history/session-adapter';
import { ErrorCode } from '../../../src/shared/errors/error-code';
import { validationError } from '../../../src/shared/errors/errors';

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

    expect(b.getMessages).toHaveBeenCalledWith('sess-7', undefined);
    expect(b.addMessages).toHaveBeenNthCalledWith(1, 'sess-7', [message]);
    expect(b.addMessages).toHaveBeenNthCalledWith(2, 'sess-7', [message, message]);
    expect(b.clear).toHaveBeenCalledWith('sess-7');
  });

  it('declares a LangChain namespace so it is a valid message history', () => {
    const history = new DynamoDBSessionChatMessageHistory(backend(), 's');
    expect(history.lc_namespace).toEqual(['langchain', 'stores', 'message', 'dynamodb']);
  });
});

describe('bound read window (HIST-06)', () => {
  it('passes the window it was created with to every read', async () => {
    const b = backend();
    await new DynamoDBSessionChatMessageHistory(b, 's', { limit: 20 }).getMessages();
    expect(b.getMessages).toHaveBeenCalledWith('s', { limit: 20 });
  });
});

/**
 * The constructor is where a caller-supplied backend, session id and window
 * first pass through this adapter, so refusing a bad one here reports a
 * configuration mistake at construction instead of rebranding it as an
 * upstream failure on first use.
 */
describe('validates its constructor arguments', () => {
  it('refuses a backend that is not an object', () => {
    expect(() => new DynamoDBSessionChatMessageHistory(null as never, 's')).toThrow(
      expect.objectContaining({ code: 'VALIDATION', context: { field: 'backend' } }),
    );
  });

  it('refuses a backend missing every method this adapter calls', () => {
    expect(() => new DynamoDBSessionChatMessageHistory({} as never, 's')).toThrow(
      expect.objectContaining({ code: 'VALIDATION', context: { field: 'backend.getMessages' } }),
    );
  });

  it('refuses a backend missing only clear', () => {
    const partial = { getMessages: jest.fn(), addMessages: jest.fn() };
    expect(() => new DynamoDBSessionChatMessageHistory(partial as never, 's')).toThrow(
      expect.objectContaining({ code: 'VALIDATION', context: { field: 'backend.clear' } }),
    );
  });

  it('refuses a non-string sessionId', () => {
    expect(() => new DynamoDBSessionChatMessageHistory(backend(), 1 as never)).toThrow(
      expect.objectContaining({ code: 'VALIDATION', context: { field: 'sessionId' } }),
    );
  });

  it('refuses a window carrying a key AdapterWindow does not declare', () => {
    expect(
      () => new DynamoDBSessionChatMessageHistory(backend(), 's', { foo: 1 } as never),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION', context: { field: 'window.foo' } }));
  });

  /**
   * Zero is refused here and answered on every listing in this package,
   * because the window this adapter carries is what
   * `RunnableWithMessageHistory` reads: an empty one is a conversation the
   * model is told never happened, and its answer is persisted as the
   * transcript. Refusing it at construction reports the mistake where it was
   * made, not on the first chain invocation.
   */
  it('refuses a window limit below 1', () => {
    for (const limit of [0, -1]) {
      expect(() => new DynamoDBSessionChatMessageHistory(backend(), 's', { limit })).toThrow(
        expect.objectContaining({ code: 'VALIDATION', context: { field: 'limit' } }),
      );
    }
  });

  it('constructs with a valid backend, sessionId and window', () => {
    expect(
      () => new DynamoDBSessionChatMessageHistory(backend(), 's', { limit: 10 }),
    ).not.toThrow();
  });
});

/**
 * The backend behind this adapter is whatever the caller supplied to
 * `DynamoDBChatMessageHistory`, so a raw failure from it must still cross the
 * same error boundary every other public method does: unbranded becomes a
 * `DynamoDBLangGraphError` carrying the code the classifier assigns — here
 * `UNEXPECTED_ERROR`, since a bare `Error` is not AWS-shaped — and an error
 * this library already branded passes through exactly as raised.
 */
describe('crosses the error boundary like every other public method', () => {
  const cause = new Error('boom');
  const refusal = validationError('bad session id', 'sessionId');

  it('getMessages wraps a plain Error and passes a VALIDATION error through unchanged', async () => {
    const b = backend();
    const history = new DynamoDBSessionChatMessageHistory(b, 's');

    b.getMessages.mockRejectedValueOnce(cause);
    await expect(history.getMessages()).rejects.toMatchObject({
      name: 'DynamoDBLangGraphError',
      code: ErrorCode.UNEXPECTED_ERROR,
    });

    b.getMessages.mockRejectedValueOnce(refusal);
    const rejection = history.getMessages();
    await expect(rejection).rejects.toBe(refusal);
    await expect(rejection).rejects.toMatchObject({
      code: 'VALIDATION',
      context: { field: 'sessionId' },
    });
  });

  it('addMessage wraps a plain Error and passes a VALIDATION error through unchanged', async () => {
    const b = backend();
    const history = new DynamoDBSessionChatMessageHistory(b, 's');
    const message = new HumanMessage('hi');

    b.addMessages.mockRejectedValueOnce(cause);
    await expect(history.addMessage(message)).rejects.toMatchObject({
      name: 'DynamoDBLangGraphError',
      code: ErrorCode.UNEXPECTED_ERROR,
    });

    b.addMessages.mockRejectedValueOnce(refusal);
    const rejection = history.addMessage(message);
    await expect(rejection).rejects.toBe(refusal);
    await expect(rejection).rejects.toMatchObject({
      code: 'VALIDATION',
      context: { field: 'sessionId' },
    });
  });

  it('addMessages wraps a plain Error and passes a VALIDATION error through unchanged', async () => {
    const b = backend();
    const history = new DynamoDBSessionChatMessageHistory(b, 's');
    const message = new HumanMessage('hi');

    b.addMessages.mockRejectedValueOnce(cause);
    await expect(history.addMessages([message])).rejects.toMatchObject({
      name: 'DynamoDBLangGraphError',
      code: ErrorCode.UNEXPECTED_ERROR,
    });

    b.addMessages.mockRejectedValueOnce(refusal);
    const rejection = history.addMessages([message]);
    await expect(rejection).rejects.toBe(refusal);
    await expect(rejection).rejects.toMatchObject({
      code: 'VALIDATION',
      context: { field: 'sessionId' },
    });
  });

  it('clear wraps a plain Error and passes a VALIDATION error through unchanged', async () => {
    const b = backend();
    const history = new DynamoDBSessionChatMessageHistory(b, 's');

    b.clear.mockRejectedValueOnce(cause);
    await expect(history.clear()).rejects.toMatchObject({
      name: 'DynamoDBLangGraphError',
      code: ErrorCode.UNEXPECTED_ERROR,
    });

    b.clear.mockRejectedValueOnce(refusal);
    const rejection = history.clear();
    await expect(rejection).rejects.toBe(refusal);
    await expect(rejection).rejects.toMatchObject({
      code: 'VALIDATION',
      context: { field: 'sessionId' },
    });
  });
});
