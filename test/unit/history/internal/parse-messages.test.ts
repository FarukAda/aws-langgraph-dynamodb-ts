import { type StoredMessage, HumanMessage } from '@langchain/core/messages';

import {
  parseMessages,
  parseMessageWindow,
  parseSessionId,
  parseStoredMessages,
} from '../../../../src/history/internal/parse';
import {
  MAX_LOGGED_VALUE_CHARS,
  MAX_PAGE_LIMIT,
  MAX_RELAYED_MESSAGE_CHARS,
} from '../../../../src/shared/constants';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { truncateForLog, truncateRelayedText } from '../../../../src/shared/logging/truncate';
import { ULID_TIME_RANGE_MS } from '../../../../src/shared/ulid';

function expectValidationError(fn: () => void): void {
  try {
    fn();
    throw new Error('should have thrown');
  } catch (error) {
    expect((error as { code: ErrorCode }).code).toBe(ErrorCode.VALIDATION);
  }
}

describe('parseSessionId', () => {
  it('accepts an ordinary session id', () => {
    expect(() => parseSessionId('session-1')).not.toThrow();
  });

  it('rejects an empty or non-string session id', () => {
    expectValidationError(() => parseSessionId(''));
    expectValidationError(() => parseSessionId(null));
  });

  it('rejects the reserved separator (M12)', () => {
    expectValidationError(() => parseSessionId('a#b'));
  });

  it('bounds the session id at 1024 bytes and rejects a whitespace-only one (SEC-10)', () => {
    expect(() => parseSessionId('s'.repeat(1024))).not.toThrow();
    expectValidationError(() => parseSessionId('s'.repeat(1025)));
    expectValidationError(() => parseSessionId('  '));
  });

  it('rejects control characters (M7)', () => {
    expectValidationError(() => parseSessionId('s\u001b[31m'));
  });
});

describe('parseMessages', () => {
  it('accepts an array, empty or not', () => {
    expect(() => parseMessages([])).not.toThrow();
    expect(() => parseMessages([new HumanMessage('hi')])).not.toThrow();
  });

  it('rejects anything that is not an array, naming messages', () => {
    for (const messages of ['x', null, undefined, {}]) {
      expectValidationError(() => parseMessages(messages as never));
    }
  });
});

describe('parseMessages', () => {
  it('serializes real messages in order', () => {
    const stored = parseMessages([new HumanMessage('one'), new HumanMessage('two')]);
    expect(stored.map((message) => message.data.content)).toEqual(['one', 'two']);
  });

  /**
   * A JavaScript caller, or an `any` arriving through a chain, used to fail with
   * `TypeError: message.toDict is not a function` from inside LangChain — no
   * index, no field, no sign of which library refused it.
   */
  it('names the offending index for a value that is not a message', () => {
    expect(() => parseMessages([new HumanMessage('ok'), {} as never])).toThrow(
      /messages\[1\] is not a LangChain message/,
    );
    expectValidationError(() => parseMessages(['hi' as never]));
    expectValidationError(() => parseMessages([null as never]));
  });

  it('accepts an empty list', () => {
    expect(parseMessages([])).toEqual([]);
  });

  /**
   * LangChain renders the value it refused into the text it throws, so the
   * relayed half is as long as the caller's own object makes it. It is prose
   * rather than an identifier, so it takes the relay cap.
   */
  it('bounds what LangChain says about the value it refused', () => {
    const detail = 'n'.repeat(MAX_RELAYED_MESSAGE_CHARS * 2);
    const shape = {
      toDict: () => {
        throw new Error(detail);
      },
    };
    try {
      parseMessages([shape as never]);
      throw new Error('should have thrown');
    } catch (error) {
      const coded = error as { context?: { field?: string }; message: string };
      expect(coded.context?.field).toBe('messages');
      expect(coded.message).not.toContain(detail);
      expect(coded.message).toContain(truncateRelayedText(detail));
    }
  });
});

describe('parseStoredMessages (HIST-04)', () => {
  const stored = (type: string, data: Record<string, string | undefined>): StoredMessage =>
    ({ type, data: { content: 'c', ...data } }) as StoredMessage;

  it('accepts every message type the read side can rebuild', () => {
    expect(() =>
      parseStoredMessages([
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
    expect(() => parseStoredMessages([stored('human', {}), stored('remove', { id: 'x' })])).toThrow(
      /messages\[1\] of type "remove"/,
    );
    expectValidationError(() => parseStoredMessages([stored('remove', { id: 'x' })]));
  });

  it('rejects a tool message without its tool_call_id, and a function message without a name', () => {
    expectValidationError(() => parseStoredMessages([stored('tool', {})]));
    expectValidationError(() => parseStoredMessages([stored('function', {})]));
  });

  it('accepts an empty list', () => {
    expect(() => parseStoredMessages([])).not.toThrow();
  });

  /**
   * The type comes off the caller's own object and nothing length-checked it,
   * so the message names it bounded — and so is what LangChain says about it,
   * because that text renders the same unchecked value into itself and
   * bounding only the type left the message as long as it ever was.
   * `context.field` stays `messages`, which is what a caller branches on. The
   * two halves take different caps: the type is an identifier, while what
   * LangChain threw is prose, cut once by `redactedMessage` and not again
   * here — a second cut would state the length of the first cut's output
   * rather than the length the caller's text really had.
   */
  it('bounds the type it quotes and the text LangChain renders it into', () => {
    const type = 'r'.repeat(MAX_RELAYED_MESSAGE_CHARS * 4);
    try {
      parseStoredMessages([stored(type, { id: 'x' })]);
      throw new Error('should have thrown');
    } catch (error) {
      const coded = error as { context?: { field?: string }; message: string };
      expect(coded.context?.field).toBe('messages');
      expect(coded.message).not.toContain(type);
      expect(coded.message).toContain(truncateForLog(type));
      expect(coded.message.length).toBeLessThan(type.length);
      expect(coded.message.length).toBeLessThan(
        MAX_LOGGED_VALUE_CHARS + MAX_RELAYED_MESSAGE_CHARS + 200,
      );
    }
  });

  /**
   * The relayed half is marked with the length the caller's text really had.
   * Cutting it twice — once in `redactedMessage`, once again at the call site —
   * would mark the intermediate length instead, which is exactly what the mark
   * exists to prevent.
   */
  it('marks the relayed text with the length it really had, never a cut one', () => {
    const type = 'r'.repeat(MAX_RELAYED_MESSAGE_CHARS * 4);
    try {
      parseStoredMessages([stored(type, { id: 'x' })]);
      throw new Error('should have thrown');
    } catch (error) {
      const marks = [...(error as Error).message.matchAll(/…\(len (\d+)\)/g)].map((match) =>
        Number(match[1]),
      );
      expect(marks).toHaveLength(2);
      expect(marks[0]).toBe(type.length);
      expect(marks[1]).toBeGreaterThan(type.length);
    }
  });
});

describe('parseMessageWindow (HIST-06)', () => {
  it('accepts an empty window, a positive integer limit and a valid Date', () => {
    expect(() => parseMessageWindow({})).not.toThrow();
    expect(() => parseMessageWindow({ limit: 1, before: new Date(0) })).not.toThrow();
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
    expect(() => parseMessageWindow({ limit: MAX_PAGE_LIMIT })).not.toThrow();
    expectValidationError(() => parseMessageWindow({ limit: 0 }));
  });

  it('rejects a negative, fractional, oversized or non-numeric limit', () => {
    expectValidationError(() => parseMessageWindow({ limit: -1 }));
    expectValidationError(() => parseMessageWindow({ limit: 2.5 }));
    expectValidationError(() => parseMessageWindow({ limit: MAX_PAGE_LIMIT + 1 }));
    expectValidationError(() => parseMessageWindow({ limit: '3' as never }));
  });

  it('rejects an invalid Date and a non-Date before', () => {
    expectValidationError(() => parseMessageWindow({ before: new Date('x') }));
    expectValidationError(() => parseMessageWindow({ before: 5 as never }));
    expectValidationError(() => parseMessageWindow({ before: '2024-01-01' as never }));
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
    expectValidationError(() => parseMessageWindow({ before: new Date(-1) }));
    expectValidationError(() => parseMessageWindow({ before: new Date(-1000) }));
    expectValidationError(() => parseMessageWindow({ before: new Date(ULID_TIME_RANGE_MS) }));
    expect(() => parseMessageWindow({ before: new Date(ULID_TIME_RANGE_MS - 1) })).not.toThrow();
  });
});
