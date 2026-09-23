import { AIMessage, HumanMessage, type StoredMessage } from '@langchain/core/messages';
import { expectTypeOf } from 'expect-type';

import {
  type GetMessagesRequest,
  type ListSessionsRequest,
  parseGetMessagesRequest,
  type ParsedWindow,
  parseListSessionsRequest,
  parseMessages,
  parseMessageWindow,
  parseSessionId,
  parseStoredMessages,
  type SessionId,
  type StorableMessages,
} from '../../../../src/history/internal/parse';
import { MAX_PAGE_LIMIT } from '../../../../src/shared/constants';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { ULID_TIME_RANGE_MS } from '../../../../src/shared/ulid';

/** Matches the `VALIDATION` refusal naming `field`. */
const refusal = (field: string) =>
  expect.objectContaining({
    code: ErrorCode.VALIDATION,
    context: expect.objectContaining({ field }),
  });

const stored = (type: string, data: Record<string, unknown>): StoredMessage =>
  ({ type, data: { content: 'x', ...data } }) as StoredMessage;

describe('parseSessionId', () => {
  it('returns a well-formed id and refuses a malformed one', () => {
    expect(parseSessionId('s-1')).toBe('s-1');
    expect(parseSessionId('s'.repeat(1024))).toHaveLength(1024);
    for (const value of ['', '  ', 'a#b', 'a\u0007b', 's'.repeat(1025), 42, undefined]) {
      expect(() => parseSessionId(value)).toThrow(refusal('sessionId'));
    }
  });
});

describe('parseMessages', () => {
  it('turns LangChain messages into the stored form, in order', () => {
    const parsed = parseMessages([new HumanMessage('one'), new AIMessage('two')]);
    expect(parsed.map((message) => message.type)).toEqual(['human', 'ai']);
    expect(parsed.map((message) => message.data.content)).toEqual(['one', 'two']);
    expect(parseMessages([])).toEqual([]);
  });

  it('refuses a list that is not an array, and names the index of an entry that is not a message', () => {
    expect(() => parseMessages('hi' as never)).toThrow(refusal('messages'));
    expect(() => parseMessages([new HumanMessage('ok'), {} as never])).toThrow(/messages\[1\]/);
  });
});

describe('parseStoredMessages', () => {
  it('returns what the read side can rebuild', () => {
    const messages = [stored('human', {}), stored('ai', {})];
    expect(parseStoredMessages(messages)).toBe(messages);
  });

  it('refuses a type the read side cannot rebuild, naming its index and type', () => {
    expect(() => parseStoredMessages([stored('human', {}), stored('remove', { id: 'x' })])).toThrow(
      /messages\[1\] of type "remove" cannot be stored/,
    );
    expect(() => parseStoredMessages([stored('tool', {})])).toThrow(refusal('messages'));
  });
});

describe('parseMessageWindow', () => {
  it('keeps only the keys the caller gave, and copies the bound', () => {
    expect(parseMessageWindow({})).toEqual({});
    expect(Object.keys(parseMessageWindow({ limit: 5 }))).toEqual(['limit']);
    const before = new Date(1_000);
    const parsed = parseMessageWindow({ limit: MAX_PAGE_LIMIT, before });
    before.setTime(2_000);
    expect(parsed.limit).toBe(MAX_PAGE_LIMIT);
    expect(parsed.before?.getTime()).toBe(1_000);
  });

  it('refuses a limit of zero, which would feed a model an empty conversation', () => {
    expect(() => parseMessageWindow({ limit: 0 })).toThrow(refusal('limit'));
    expect(() => parseMessageWindow({ limit: MAX_PAGE_LIMIT + 1 })).toThrow(refusal('limit'));
  });

  it.each([null, 'yesterday', new Date(Number.NaN), new Date(-1), new Date(ULID_TIME_RANGE_MS)])(
    'refuses %p as a bound no message id can express',
    (before) => {
      expect(() => parseMessageWindow({ before: before as never })).toThrow(refusal('before'));
    },
  );
});

describe('parseGetMessagesRequest', () => {
  it('parses the options, then the session, then the window', () => {
    const signal = new AbortController().signal;
    expect(parseGetMessagesRequest('s', { limit: 2, signal })).toEqual({
      sessionId: 's',
      window: { limit: 2 },
      signal,
    });
    expect(() => parseGetMessagesRequest('a#b', { bogus: 1 } as never)).toThrow(
      refusal('options.bogus'),
    );
    expect(() => parseGetMessagesRequest('a#b', { signal: {} as never })).toThrow(
      refusal('signal'),
    );
    expect(() => parseGetMessagesRequest('a#b', { limit: 0 })).toThrow(refusal('sessionId'));
    expect(() => parseGetMessagesRequest('s', { limit: 0 })).toThrow(refusal('limit'));
  });
});

describe('parseListSessionsRequest', () => {
  it('reads every option, leaving an unset one unset', () => {
    expect(parseListSessionsRequest({}, undefined)).toEqual({
      limit: undefined,
      maxItems: undefined,
      maxIterations: undefined,
      cursor: undefined,
      signal: undefined,
    });
    expect(
      parseListSessionsRequest(
        { limit: 0, maxItems: Infinity, maxIterations: 3, cursor: 'c' },
        'gsi1',
      ),
    ).toMatchObject({ limit: 0, maxItems: Infinity, maxIterations: 3, cursor: 'c' });
  });

  it('refuses each malformed option in the order they used to be checked', () => {
    expect(() => parseListSessionsRequest({ bogus: 1 } as never, 'gsi1')).toThrow(
      refusal('options.bogus'),
    );
    expect(() => parseListSessionsRequest({ limit: -1, maxItems: 0 }, 'gsi1')).toThrow(
      refusal('limit'),
    );
    expect(() => parseListSessionsRequest({ maxItems: 0, maxIterations: 0 }, 'gsi1')).toThrow(
      refusal('maxItems'),
    );
    expect(() => parseListSessionsRequest({ maxIterations: 1.5 }, 'gsi1')).toThrow(
      refusal('maxIterations'),
    );
    expect(() => parseListSessionsRequest({ cursor: 'c' }, undefined)).toThrow(
      /paging by cursor needs a configured `indexName`/,
    );
    expect(() => parseListSessionsRequest({ cursor: 7 as never }, 'gsi1')).toThrow(
      refusal('cursor'),
    );
  });
});

describe('the parsed types', () => {
  it('cannot be forged, and are what the parsers return', () => {
    expectTypeOf<string>().not.toMatchTypeOf<SessionId>();
    expectTypeOf<StoredMessage[]>().not.toMatchTypeOf<StorableMessages>();
    expectTypeOf<{ limit?: number }>().not.toMatchTypeOf<ParsedWindow>();
    expectTypeOf(parseGetMessagesRequest('s', {})).toEqualTypeOf<GetMessagesRequest>();
    expectTypeOf(parseListSessionsRequest({}, undefined)).toEqualTypeOf<ListSessionsRequest>();
  });
});
