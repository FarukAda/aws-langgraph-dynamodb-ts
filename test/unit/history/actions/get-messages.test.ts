import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { AIMessage, HumanMessage, mapChatMessagesToStoredMessages } from '@langchain/core/messages';

import { getMessages } from '../../../../src/history/actions/get-messages';
import { parseSessionId } from '../../../../src/history/internal/parse';
import { buildMessageItem } from '../../../../src/history/internal/rows';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { buildS3Key } from '../../../../src/shared/codec/s3/config';
import { assertKeyInScope } from '../../../../src/shared/codec/s3/key-scope';
import { MAX_LOGGED_VALUE_CHARS } from '../../../../src/shared/constants';
import { DynamoDBLangGraphError } from '../../../../src/shared/errors/base-error';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { truncateForLog } from '../../../../src/shared/logging/truncate';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { FROZEN_NOW_MS } from '../../../shared/helpers/test-setup';

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

/** An offloader whose uploads succeed and whose downloads run `download`. */
function offloaderStub(download: () => Promise<Uint8Array>) {
  return {
    shouldOffload: () => true,
    buildKey: (parts: readonly string[], objectId: string) => [...parts, objectId].join('/'),
    upload: (key: string) => key,
    download: jest.fn(download),
    deleteBatch: jest.fn(),
    assertOwnedKey: () => undefined,
  };
}

/** The error shape `downloadObject` raises: S3_OFFLOAD_FAILED wrapping the SDK error. */
function s3Failure(causeName: string): Error {
  return new DynamoDBLangGraphError(
    's3 failed',
    ErrorCode.S3_OFFLOAD_FAILED,
    {},
    Object.assign(new Error(causeName), { name: causeName }),
  );
}

const NOW_SECONDS = Math.floor(FROZEN_NOW_MS / 1000);
const SESSION_ID = parseSessionId('s1');

describe('getMessages', () => {
  it('returns an empty array for a session with no messages', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    expect(await getMessages(context(client), 'sess-x')).toEqual([]);
  });

  it('returns the readable messages and reports the corrupt one (I6)', async () => {
    // One undecodable item used to throw out of the whole function, so a
    // single bad row made an entire session permanently unreadable — with no
    // API to remove just that row.
    const { client, mock } = createStrictDocumentMock();
    const [human, ai] = mapChatMessagesToStoredMessages([
      new HumanMessage('hi'),
      new AIMessage('hello'),
    ]);
    const good = await buildMessageItem(context(client), {
      sessionId: SESSION_ID,
      messageId: '01A',
      message: human,
    });
    const alsoGood = await buildMessageItem(context(client), {
      sessionId: SESSION_ID,
      messageId: '01C',
      message: ai,
    });
    const corrupt = await buildMessageItem(context(client), {
      sessionId: SESSION_ID,
      messageId: '01B',
      message: human,
    });
    corrupt.message = {
      location: PayloadLocation.INLINE,
      serdeType: 'json',
      compressed: false,
      bytes: new TextEncoder().encode('{not valid json'),
    };
    mock.on(QueryCommand).resolves({ Items: [good, corrupt, alsoGood] });
    const error = jest.fn();
    const messages = await getMessages(
      { ...context(client), logger: { ...SILENT_LOGGER, error } },
      SESSION_ID,
    );
    expect(messages.map((m) => m.content)).toEqual(['hi', 'hello']);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('corrupt'),
      expect.objectContaining({ sortKey: 'HISTORY#MSG#01B' }),
    );
  });

  /**
   * The sort key comes off the row, so nothing this package validated bounds
   * it — a hand-written row under the message prefix can carry any length.
   * Every other row-sourced string a log line quotes is cut at the same cap.
   */
  it('bounds the sort key it reports for a corrupt item', async () => {
    const { client, mock } = createStrictDocumentMock();
    const [human] = mapChatMessagesToStoredMessages([new HumanMessage('hi')]);
    const corrupt = await buildMessageItem(context(client), {
      sessionId: SESSION_ID,
      messageId: '01B',
      message: human,
    });
    corrupt.SK = `HISTORY#MSG#${'0'.repeat(MAX_LOGGED_VALUE_CHARS * 4)}`;
    corrupt.message = {
      location: PayloadLocation.INLINE,
      serdeType: 'json',
      compressed: false,
      bytes: new TextEncoder().encode('{not valid json'),
    };
    mock.on(QueryCommand).resolves({ Items: [corrupt] });
    const error = jest.fn();
    await getMessages({ ...context(client), logger: { ...SILENT_LOGGER, error } }, 's1');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('corrupt'),
      expect.objectContaining({ sortKey: truncateForLog(corrupt.SK) }),
    );
  });

  it('throws on a corrupt item when onCorruptMessage is "throw" (I6)', async () => {
    const { client, mock } = createStrictDocumentMock();
    const [human] = mapChatMessagesToStoredMessages([new HumanMessage('hi')]);
    const corrupt = await buildMessageItem(context(client), {
      sessionId: SESSION_ID,
      messageId: '01B',
      message: human,
    });
    corrupt.message = {
      location: PayloadLocation.INLINE,
      serdeType: 'json',
      compressed: false,
      bytes: new TextEncoder().encode('{not valid json'),
    };
    mock.on(QueryCommand).resolves({ Items: [corrupt] });
    await expect(
      getMessages({ ...context(client), onCorruptMessage: 'throw' }, 's1'),
    ).rejects.toThrow();
  });

  describe('failure classification under the skip policy (HIST-01, HIST-04, CODEC-03)', () => {
    async function offloadedHuman(client: HistoryContext['client']) {
      const writer = context(client, {
        offloader: offloaderStub(() => Promise.resolve(new Uint8Array())) as never,
      });
      const [human] = mapChatMessagesToStoredMessages([new HumanMessage('offloaded')]);
      return buildMessageItem(writer, { sessionId: SESSION_ID, messageId: '01A', message: human });
    }

    it("rethrows a transient S3 failure under 'skip' instead of silently dropping the message", async () => {
      const { client, mock } = createStrictDocumentMock();
      const error = jest.fn();
      const reader = context(client, {
        offloader: offloaderStub(() => {
          throw s3Failure('ServiceUnavailable');
        }) as never,
        logger: { ...SILENT_LOGGER, error },
      });
      mock.on(QueryCommand).resolves({ Items: [await offloadedHuman(client)] });
      await expect(getMessages(reader, 's1')).rejects.toMatchObject({
        code: ErrorCode.S3_OFFLOAD_FAILED,
      });
      expect(error).not.toHaveBeenCalled();
    });

    it("rethrows a raw AWS permission error under 'skip'", async () => {
      const { client, mock } = createStrictDocumentMock();
      const reader = context(client, {
        offloader: offloaderStub(() => {
          throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
        }) as never,
      });
      mock.on(QueryCommand).resolves({ Items: [await offloadedHuman(client)] });
      await expect(getMessages(reader, 's1')).rejects.toMatchObject({
        name: 'AccessDeniedException',
      });
    });

    it('skips a message whose S3 object no longer exists and logs it (NoSuchKey)', async () => {
      const { client, mock } = createStrictDocumentMock();
      const error = jest.fn();
      const reader = context(client, {
        offloader: offloaderStub(() => {
          throw s3Failure('NoSuchKey');
        }) as never,
        logger: { ...SILENT_LOGGER, error },
      });
      const [ai] = mapChatMessagesToStoredMessages([new AIMessage('inline')]);
      const inline = await buildMessageItem(context(client), {
        sessionId: SESSION_ID,
        messageId: '01B',
        message: ai,
      });
      mock.on(QueryCommand).resolves({ Items: [await offloadedHuman(client), inline] });
      const messages = await getMessages(reader, 's1');
      expect(messages.map((m) => m.content)).toEqual(['inline']);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('corrupt'),
        expect.objectContaining({ sortKey: 'HISTORY#MSG#01A', reason: 'S3_OFFLOAD_FAILED' }),
      );
    });

    it('rethrows a VALIDATION error when a message is offloaded but the reader has no s3', async () => {
      const { client, mock } = createStrictDocumentMock();
      mock.on(QueryCommand).resolves({ Items: [await offloadedHuman(client)] });
      await expect(getMessages(context(client), 's1')).rejects.toMatchObject({
        code: ErrorCode.VALIDATION,
      });
    });

    it('skips a stored message whose type cannot be rebuilt without poisoning the rest', async () => {
      const { client, mock } = createStrictDocumentMock();
      const error = jest.fn();
      const [human, ai] = mapChatMessagesToStoredMessages([
        new HumanMessage('hi'),
        new AIMessage('hello'),
      ]);
      const ctx = context(client);
      const items = [
        await buildMessageItem(ctx, { sessionId: SESSION_ID, messageId: '01A', message: human }),
        await buildMessageItem(ctx, {
          sessionId: SESSION_ID,
          messageId: '01B',
          message: {
            type: 'remove',
            data: {
              content: '',
              id: 'x',
              role: undefined,
              name: undefined,
              tool_call_id: undefined,
            },
          },
        }),
        await buildMessageItem(ctx, { sessionId: SESSION_ID, messageId: '01C', message: ai }),
      ];
      mock.on(QueryCommand).resolves({ Items: items });
      const messages = await getMessages({ ...ctx, logger: { ...SILENT_LOGGER, error } }, 's1');
      expect(messages.map((m) => m.content)).toEqual(['hi', 'hello']);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('corrupt'),
        expect.objectContaining({ sortKey: 'HISTORY#MSG#01B' }),
      );
    });

    it('skips a message that trips the decompression guard', async () => {
      const { client, mock } = createStrictDocumentMock();
      const error = jest.fn();
      const writer = context(client, { compression: { enabled: true, minSizeBytes: 0 } });
      const [big, small] = mapChatMessagesToStoredMessages([
        new HumanMessage('x'.repeat(4096)),
        new AIMessage('ok'),
      ]);
      const compressed = await buildMessageItem(writer, {
        sessionId: SESSION_ID,
        messageId: '01A',
        message: big,
      });
      expect(compressed.message.compressed).toBe(true);
      const items = [
        compressed,
        await buildMessageItem(writer, { sessionId: SESSION_ID, messageId: '01B', message: small }),
      ];
      mock.on(QueryCommand).resolves({ Items: items });
      const reader = context(client, {
        compression: { enabled: true, maxDecompressedBytes: 16 },
        logger: { ...SILENT_LOGGER, error },
      });
      const messages = await getMessages(reader, 's1');
      expect(messages.map((m) => m.content)).toEqual(['ok']);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('corrupt'),
        expect.objectContaining({ sortKey: 'HISTORY#MSG#01A' }),
      );
    });
  });

  it('rejects an invalid session id instead of reaching DynamoDB (M12)', async () => {
    const { client, mock } = createStrictDocumentMock();
    await expect(getMessages(context(client), '')).rejects.toThrow(/sessionId/);
    await expect(getMessages(context(client), 'a#b')).rejects.toThrow(/reserved "#" separator/);
    expect(mock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('queries the message items and returns them decoded, in order', async () => {
    const { client, mock } = createStrictDocumentMock();
    const [human, ai] = mapChatMessagesToStoredMessages([
      new HumanMessage('hi'),
      new AIMessage('hello'),
    ]);
    const items = [
      await buildMessageItem(context(client), {
        sessionId: SESSION_ID,
        messageId: '01A',
        message: human,
      }),
      await buildMessageItem(context(client), {
        sessionId: SESSION_ID,
        messageId: '01B',
        message: ai,
      }),
    ];
    mock.on(QueryCommand).resolves({ Items: items });
    const messages = await getMessages(context(client), 's1');
    expect(messages.map((m) => m.content)).toEqual(['hi', 'hello']);
    expect(messages[0].getType()).toBe('human');
    expect(messages[1].getType()).toBe('ai');
    const input = mock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.ScanIndexForward).toBe(true);
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'HIST#s1', ':skp': 'HISTORY#MSG#' });
    // Read-your-writes for RunnableWithMessageHistory: the turn just appended
    // must be visible to the very next getMessages (HIST-02).
    expect(input.ConsistentRead).toBe(true);
  });

  it('filters out TTL-expired message items on read', async () => {
    const { client, mock } = createStrictDocumentMock();
    const [live, gone] = mapChatMessagesToStoredMessages([
      new HumanMessage('hi'),
      new AIMessage('gone'),
    ]);
    const items = [
      await buildMessageItem(context(client), {
        sessionId: SESSION_ID,
        messageId: '01A',
        message: live,
      }),
      await buildMessageItem(context(client), {
        sessionId: SESSION_ID,
        messageId: '01B',
        message: gone,
        ttlTimestamp: NOW_SECONDS - 10,
      }),
    ];
    mock.on(QueryCommand).resolves({ Items: items });
    const messages = await getMessages(context(client), 's1');
    expect(messages.map((m) => m.content)).toEqual(['hi']);
  });

  it('reads past the default in-memory item cap instead of throwing', async () => {
    const { client, mock } = createStrictDocumentMock();
    const [human] = mapChatMessagesToStoredMessages([new HumanMessage('hi')]);
    const pageSize = 2500;
    // 12,500 items total, > the 10,000 default cap
    const pageCount = 5;
    let mockChain = mock.on(QueryCommand);
    for (let i = 0; i < pageCount; i++) {
      const items = await Promise.all(
        Array.from({ length: pageSize }, (_, j) =>
          buildMessageItem(context(client), {
            sessionId: SESSION_ID,
            messageId: `01${i}${j}`,
            message: human,
          }),
        ),
      );
      mockChain = mockChain.resolvesOnce({
        Items: items,
        LastEvaluatedKey: i < pageCount - 1 ? { PK: 's1', SK: String(i) } : undefined,
      });
    }
    const result = await getMessages(context(client), 's1');
    expect(result).toHaveLength(pageSize * pageCount);
  });
});

describe('options shape (M-08)', () => {
  it('refuses a key this package does not read, naming it under options', async () => {
    const { client } = createStrictDocumentMock();
    await expect(
      getMessages(context(client), 's1', { limit: 1, bogus: true } as never),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'options.bogus' } });
  });

  it('refuses a signal that is not AbortSignal-like', async () => {
    const { client } = createStrictDocumentMock();
    await expect(getMessages(context(client), 's1', { signal: {} as never })).rejects.toMatchObject(
      { code: ErrorCode.VALIDATION, context: { field: 'signal' } },
    );
  });
});

describe('S3 key binding (SEC-03)', () => {
  const binding = () => ({
    shouldOffload: () => true,
    buildKey: (parts: readonly string[], objectId: string) => buildS3Key('p/', parts, objectId),
    upload: (key: string) => key,
    download: jest.fn(() => new Uint8Array()),
    deleteBatch: jest.fn(),
    assertOwnedKey: (key: string, scope: readonly string[]) => assertKeyInScope(key, 'p/', scope),
  });

  async function foreignItem(
    client: HistoryContext['client'],
    offloader: ReturnType<typeof binding>,
  ) {
    const [human] = mapChatMessagesToStoredMessages([new HumanMessage('offloaded')]);
    const item = await buildMessageItem(context(client, { offloader: offloader as never }), {
      sessionId: SESSION_ID,
      messageId: '01A',
      message: human,
    });
    item.message = {
      location: PayloadLocation.S3,
      serdeType: 'json',
      compressed: false,
      s3Key: buildS3Key('p/', ['victim'], '01A'),
    };
    return item;
  }

  /**
   * The `'skip'` policy covers a payload nobody can read. A key outside the
   * session's path is a wrong prefix or a foreign row, so it is reported
   * under both policies rather than healed over with a shorter conversation.
   */
  it("throws on a message whose key lies outside the session's path under 'skip', logging nothing", async () => {
    const { client, mock } = createStrictDocumentMock();
    const offloader = binding();
    mock.on(QueryCommand).resolves({ Items: [await foreignItem(client, offloader)] });
    const error = jest.fn();
    const reader = context(client, {
      offloader: offloader as never,
      logger: { ...SILENT_LOGGER, error },
    });
    await expect(getMessages(reader, 's1')).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 's3Key' },
    });
    expect(offloader.download).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("throws on such a message under 'throw'", async () => {
    const { client, mock } = createStrictDocumentMock();
    const offloader = binding();
    mock.on(QueryCommand).resolves({ Items: [await foreignItem(client, offloader)] });
    const reader = context(client, { offloader: offloader as never, onCorruptMessage: 'throw' });
    await expect(getMessages(reader, 's1')).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 's3Key' },
    });
  });
});
