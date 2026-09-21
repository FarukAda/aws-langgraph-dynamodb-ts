import { type StoredMessage, HumanMessage } from '@langchain/core/messages';

import {
  toStoredMessages,
  validateMessageList,
  validateMessageWindow,
  validateSessionId,
  validateStorableMessages,
} from '../../../../src/history/internal/validation';
import { MAX_PAGE_LIMIT } from '../../../../src/shared/constants';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { ULID_TIME_RANGE_MS } from '../../../../src/shared/ulid';

function expectValidationError(fn: () => void): void {
  try {
    fn();
    throw new Error('should have thrown');
  } catch (error) {
    expect((error as { code: ErrorCode }).code).toBe(ErrorCode.VALIDATION);
  }
}

describe('validateSessionId', () => {
  it('accepts an ordinary session id', () => {
    expect(() => validateSessionId('session-1')).not.toThrow();
  });

  it('rejects an empty or non-string session id', () => {
    expectValidationError(() => validateSessionId(''));
    expectValidationError(() => validateSessionId(null as never));
  });

  it('rejects the reserved separator (M12)', () => {
    expectValidationError(() => validateSessionId('a#b'));
  });

  it('bounds the session id at 1024 bytes and rejects a whitespace-only one (SEC-10)', () => {
    expect(() => validateSessionId('s'.repeat(1024))).not.toThrow();
    expectValidationError(() => validateSessionId('s'.repeat(1025)));
    expectValidationError(() => validateSessionId('  '));
  });

  it('rejects control characters (M7)', () => {
    expectValidationError(() => validateSessionId('s\u001b[31m'));
  });
});

describe('validateMessageList', () => {
  it('accepts an array, empty or not', () => {
    expect(() => validateMessageList([])).not.toThrow();
    expect(() => validateMessageList([new HumanMessage('hi')])).not.toThrow();
  });

  it('rejects anything that is not an array, naming messages', () => {
    for (const messages of ['x', null, undefined, {}]) {
      expectValidationError(() => validateMessageList(messages as never));
    }
  });
});

describe('toStoredMessages', () => {
  it('serializes real messages in order', () => {
    const stored = toStoredMessages([new HumanMessage('one'), new HumanMessage('two')]);
    expect(stored.map((message) => message.data.content)).toEqual(['one', 'two']);
  });

  /**
   * A JavaScript caller, or an `any` arriving through a chain, used to fail with
   * `TypeError: message.toDict is not a function` from inside LangChain — no
   * index, no field, no sign of which library refused it.
   */
  it('names the offending index for a value that is not a message', () => {
    expect(() => toStoredMessages([new HumanMessage('ok'), {} as never])).toThrow(
      /messages\[1\] is not a LangChain message/,
    );
    expectValidationError(() => toStoredMessages(['hi' as never]));
    expectValidationError(() => toStoredMessages([null as never]));
  });

  it('accepts an empty list', () => {
    expect(toStoredMessages([])).toEqual([]);
  });
});

describe('validateStorableMessages (HIST-04)', () => {
  const stored = (type: string, data: Record<string, string | undefined>): StoredMessage =>
    ({ type, data: { content: 'c', ...data } }) as StoredMessage;

  it('accepts every message type the read side can rebuild', () => {
    expect(() =>
      validateStorableMessages([
        stored('human', {}),
        stored('ai', {}),
        stored('system', {}),
        stored('tool', { tool_call_id: 'call-1' }),
        stored('function', { name: 'fn' }),
        stored('generic', { role: 'critic' }),
      ]),
    ).not.toThrow();
  });

  it('rejects a type the read side cannot rebuild, naming the offending index and type', () => {
    expect(() =>
      validateStorableMessages([stored('human', {}), stored('remove', { id: 'x' })]),
    ).toThrow(/messages\[1\] of type "remove"/);
    expectValidationError(() => validateStorableMessages([stored('remove', { id: 'x' })]));
  });

  it('rejects a tool message without its tool_call_id, and a function message without a name', () => {
    expectValidationError(() => validateStorableMessages([stored('tool', {})]));
    expectValidationError(() => validateStorableMessages([stored('function', {})]));
  });

  it('accepts an empty list', () => {
    expect(() => validateStorableMessages([])).not.toThrow();
  });
});

describe('validateMessageWindow (HIST-06)', () => {
  it('accepts an empty window, a positive integer limit and a valid Date', () => {
    expect(() => validateMessageWindow({})).not.toThrow();
    expect(() => validateMessageWindow({ limit: 1, before: new Date(0) })).not.toThrow();
  });

  /**
   * The one `limit` in this package whose floor is 1 rather than 0. A zero
   * *page* is answered, because the caller who asked a listing for nothing can
   * see it got nothing. A zero *window* is refused: this is the window
   * `forSession` hands `RunnableWithMessageHistory`, and an empty conversation
   * is indistinguishable from a new one to the model reading it, which answers
   * as though nothing was ever said and has that answer persisted as the
   * transcript.
   */
  it('accepts the page ceiling and refuses a limit of zero', () => {
    expect(() => validateMessageWindow({ limit: MAX_PAGE_LIMIT })).not.toThrow();
    expectValidationError(() => validateMessageWindow({ limit: 0 }));
  });

  it('rejects a negative, fractional, oversized or non-numeric limit', () => {
    expectValidationError(() => validateMessageWindow({ limit: -1 }));
    expectValidationError(() => validateMessageWindow({ limit: 2.5 }));
    expectValidationError(() => validateMessageWindow({ limit: MAX_PAGE_LIMIT + 1 }));
    expectValidationError(() => validateMessageWindow({ limit: '3' as never }));
  });

  it('rejects an invalid Date and a non-Date before', () => {
    expectValidationError(() => validateMessageWindow({ before: new Date('x') }));
    expectValidationError(() => validateMessageWindow({ before: 5 as never }));
    expectValidationError(() => validateMessageWindow({ before: '2024-01-01' as never }));
  });

  /**
   * A `before` outside the range a message id can encode used to build a bound
   * out of that range anyway: a pre-epoch date yielded a prefix above every
   * real id, so the window returned the entire conversation, and a date past
   * the range wrapped to the lowest prefix and returned none of it. Both read
   * as a plausible answer to the caller, which is why the date is refused
   * instead of the bound being clamped.
   */
  it('rejects a before outside the range a message id encodes', () => {
    expectValidationError(() => validateMessageWindow({ before: new Date(-1) }));
    expectValidationError(() => validateMessageWindow({ before: new Date(-1000) }));
    expectValidationError(() => validateMessageWindow({ before: new Date(ULID_TIME_RANGE_MS) }));
    expect(() => validateMessageWindow({ before: new Date(ULID_TIME_RANGE_MS - 1) })).not.toThrow();
  });
});
