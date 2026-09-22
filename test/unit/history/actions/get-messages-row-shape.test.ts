import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { HumanMessage, mapChatMessagesToStoredMessages } from '@langchain/core/messages';

import { getMessages } from '../../../../src/history/actions/get-messages';
import { buildMessageItem } from '../../../../src/history/internal/item-mapper';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { MAX_LOGGED_VALUE_CHARS } from '../../../../src/shared/constants';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { truncateForLog } from '../../../../src/shared/logging/truncate';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function context(
  client: HistoryContext['client'],
  extra: Partial<HistoryContext> = {},
): HistoryContext {
  return {
    client,
    tableName: 'history',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    ulid: () => 'U',
    onCorruptMessage: 'skip',
    ...extra,
  };
}

/** One real message row, so a refusal is never just an empty session. */
async function realRow(client: HistoryContext['client'], ulid: string) {
  const [human] = mapChatMessagesToStoredMessages([new HumanMessage('hi')]);
  return buildMessageItem(context(client), 's1', ulid, human);
}

/**
 * A row someone else put in this session's partition under a key that looks
 * like a message. On a shared table that is the case the narrow exists for:
 * the key space is this adapter's, the row is not.
 */
const foreign = (extra: Record<string, unknown> = {}) => ({
  PK: 'HIST#s1',
  SK: 'HISTORY#MSG#01Z',
  ...extra,
});

/**
 * The refusal is the same under both policies. `skip` exists for a payload
 * that can never be read, not for a row this adapter cannot account for:
 * dropping one hands the caller a shorter conversation that
 * `RunnableWithMessageHistory` then re-persists as the whole truth.
 */
describe.each(['skip', 'throw'] as const)(
  'getMessages narrows a message row before decoding it (onCorruptMessage: %s)',
  (policy) => {
    it.each([
      ['no message attribute at all', foreign({ sessionId: 's1' })],
      ['a message attribute of null', foreign({ sessionId: 's1', message: null })],
      ['a message attribute that is not an object', foreign({ sessionId: 's1', message: 'x' })],
      ['no sessionId', foreign({ message: { location: 'INLINE' } })],
      ['a sessionId that is not a string', foreign({ sessionId: 1, message: { bytes: 1 } })],
      [
        'a sessionId naming another session',
        foreign({ sessionId: 'other', message: { location: 'INLINE' } }),
      ],
    ])('refuses a row with %s', async (_name, row) => {
      const { client, mock } = createStrictDocumentMock();
      mock.on(QueryCommand).resolves({ Items: [await realRow(client, '01A'), row] });
      await expect(
        getMessages(context(client, { onCorruptMessage: policy }), 's1'),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'message' } });
    });

    it('accepts a row this package wrote', async () => {
      const { client, mock } = createStrictDocumentMock();
      mock.on(QueryCommand).resolves({ Items: [await realRow(client, '01A')] });
      const messages = await getMessages(context(client, { onCorruptMessage: policy }), 's1');
      expect(messages.map((m) => m.content)).toEqual(['hi']);
    });
  },
);

describe('the refusal names the row an operator has to go and look at', () => {
  it('warns with the sort key, cut like every other row-sourced one', async () => {
    const { client, mock } = createStrictDocumentMock();
    const sortKey = `HISTORY#MSG#${'0'.repeat(MAX_LOGGED_VALUE_CHARS * 4)}`;
    const warn = jest.fn();
    mock.on(QueryCommand).resolves({ Items: [{ PK: 'HIST#s1', SK: sortKey, sessionId: 's1' }] });
    await expect(
      getMessages(context(client, { logger: { ...SILENT_LOGGER, warn } }), 's1'),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not a chat message item'), {
      sessionId: 's1',
      sortKey: truncateForLog(sortKey),
    });
  });
});

/**
 * The `error` line names what the failure was rather than repeating what it
 * said. That name is whatever the rebuild threw, and the rebuild runs on what
 * a caller's own `serde` handed back, so nothing this package ran checked its
 * length — while `message` is already bounded where `redactedMessage` relays
 * it. One line per corrupt row, on a read that walks a whole session.
 */
describe('the corrupt-row line bounds the failure it names', () => {
  it('cuts a reason a caller-supplied serde produced', async () => {
    const { client, mock } = createStrictDocumentMock();
    const name = 'C'.repeat(MAX_LOGGED_VALUE_CHARS * 4);
    const error = jest.fn();
    const serde = {
      dumpsTyped: JSON_SERDE.dumpsTyped,
      loadsTyped: async (): Promise<unknown> =>
        await Promise.resolve({
          get type(): string {
            throw Object.assign(new Error('cannot rebuild'), { name });
          },
        }),
    };
    mock.on(QueryCommand).resolves({ Items: [await realRow(client, '01A')] });

    const messages = await getMessages(
      context(client, { serde, logger: { ...SILENT_LOGGER, error } }),
      's1',
    );

    expect(messages).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('corrupt'),
      expect.objectContaining({ reason: truncateForLog(name) }),
    );
  });
});
