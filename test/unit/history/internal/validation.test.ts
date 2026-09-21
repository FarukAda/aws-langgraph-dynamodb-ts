import { type StoredMessage, HumanMessage } from '@langchain/core/messages';

import {
  toStoredMessages,
  validateMessageList,
  validateMessageWindow,
  validateSessionId,
  validateStorableMessages,
} from '../../../../src/history/internal/validation';
import { MAX_LOGGED_VALUE_CHARS, MAX_PAGE_LIMIT } from '../../../../src/shared/constants';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { truncateForLog } from '../../../../src/shared/logging/truncate';
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

  /**
   * LangChain renders the value it refused into the text it throws, so the
   * relayed half is as long as the caller's own object makes it.
   */
  it('bounds what LangChain says about the value it refused', () => {
    const detail = 'n'.repeat(MAX_LOGGED_VALUE_CHARS * 8);
    const shape = {
      toDict: () => {
        throw new Error(detail);
      },
    };
    try {
      toStoredMessages([shape as never]);
      throw new Error('should have thrown');
    } catch (error) {
      const coded = error as { context?: { field?: string }; message: string };
      expect(coded.context?.field).toBe('messages');
      expect(coded.message).not.toContain(detail);
      expect(coded.message).toContain(truncateForLog(detail));
    }
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

  /**
   * The type comes off the caller's own object and nothing length-checked it,
   * so the message names it bounded — and so is what LangChain says about it,
   * because that text renders the same unchecked value into itself and
   * bounding only the type left the message as long as it ever was.
   * `context.field` stays `messages`, which is what a caller branches on.
   */
  it('bounds the type it quotes and the text LangChain renders it into', () => {
    const type = 'r'.repeat(MAX_LOGGED_VALUE_CHARS * 4);
    try {
      validateStorableMessages([stored(type, { id: 'x' })]);
      throw new Error('should have thrown');
    } catch (error) {
      const coded = error as { context?: { field?: string }; message: string };
      expect(coded.context?.field).toBe('messages');
      expect(coded.message).not.toContain(type);
      expect(coded.message).toContain(truncateForLog(type));
      expect(coded.message.length).toBeLessThan(type.length);
    }
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
