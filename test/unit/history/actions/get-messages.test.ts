import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { AIMessage, HumanMessage, mapChatMessagesToStoredMessages } from '@langchain/core/messages';

import { getMessages } from '../../../../src/history/actions/get-messages';
import { buildMessageItem } from '../../../../src/history/internal/item-mapper';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { DynamoDbLangGraphError } from '../../../../src/shared/errors/base-error';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
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
    buildKey: (parts: readonly string[]) => parts.join('/'),
    upload: async (key: string) => key,
    download: jest.fn(download),
    deleteBatch: jest.fn(),
  };
}

/** The error shape `downloadObject` raises: S3_OFFLOAD_FAILED wrapping the SDK error. */
function s3Failure(causeName: string): Error {
  return new DynamoDbLangGraphError(
    's3 failed',
    ErrorCode.S3_OFFLOAD_FAILED,
    {},
    Object.assign(new Error(causeName), { name: causeName }),
  );
}

const NOW_SECONDS = Math.floor(FROZEN_NOW_MS / 1000);

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
    const good = await buildMessageItem(context(client), 's1', '01A', human);
    const alsoGood = await buildMessageItem(context(client), 's1', '01C', ai);
    const corrupt = await buildMessageItem(context(client), 's1', '01B', human);
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
      's1',
    );
    expect(messages.map((m) => m.content)).toEqual(['hi', 'hello']);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('corrupt'),
      expect.objectContaining({ sortKey: 'HISTORY#MSG#01B' }),
    );
  });

  it('throws on a corrupt item when onCorruptMessage is "throw" (I6)', async () => {
    const { client, mock } = createStrictDocumentMock();
    const [human] = mapChatMessagesToStoredMessages([new HumanMessage('hi')]);
    const corrupt = await buildMessageItem(context(client), 's1', '01B', human);
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
        offloader: offloaderStub(async () => new Uint8Array()) as never,
      });
      const [human] = mapChatMessagesToStoredMessages([new HumanMessage('offloaded')]);
      return buildMessageItem(writer, 's1', '01A', human);
    }

    it("rethrows a transient S3 failure under 'skip' instead of silently dropping the message", async () => {
      const { client, mock } = createStrictDocumentMock();
      const error = jest.fn();
      const reader = context(client, {
        offloader: offloaderStub(async () => {
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
        offloader: offloaderStub(async () => {
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
        offloader: offloaderStub(async () => {
          throw s3Failure('NoSuchKey');
        }) as never,
        logger: { ...SILENT_LOGGER, error },
      });
      const [ai] = mapChatMessagesToStoredMessages([new AIMessage('inline')]);
      const inline = await buildMessageItem(context(client), 's1', '01B', ai);
      mock.on(QueryCommand).resolves({ Items: [await offloadedHuman(client), inline] });
      const messages = await getMessages(reader, 's1');
      expect(messages.map((m) => m.content)).toEqual(['inline']);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('corrupt'),
        expect.objectContaining({ sortKey: 'HISTORY#MSG#01A', reason: 'DynamoDbLangGraphError' }),
      );
    });

    it('rethrows a ValidationError when a message is offloaded but the reader has no s3', async () => {
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
        await buildMessageItem(ctx, 's1', '01A', human),
        await buildMessageItem(ctx, 's1', '01B', {
          type: 'remove',
          data: { content: '', id: 'x' },
        }),
        await buildMessageItem(ctx, 's1', '01C', ai),
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
      const compressed = await buildMessageItem(writer, 's1', '01A', big);
      expect(compressed.message.compressed).toBe(true);
      const items = [compressed, await buildMessageItem(writer, 's1', '01B', small)];
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
      await buildMessageItem(context(client), 's1', '01A', human),
      await buildMessageItem(context(client), 's1', '01B', ai),
    ];
    mock.on(QueryCommand).resolves({ Items: items });
    const messages = await getMessages(context(client), 's1');
    expect(messages.map((m) => m.content)).toEqual(['hi', 'hello']);
    expect(messages[0].getType()).toBe('human');
    expect(messages[1].getType()).toBe('ai');
    const input = mock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.ScanIndexForward).toBe(true);
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'HIST#s1', ':skp': 'HISTORY#MSG#' });
  });

  it('filters out TTL-expired message items on read', async () => {
    const { client, mock } = createStrictDocumentMock();
    const [live, gone] = mapChatMessagesToStoredMessages([
      new HumanMessage('hi'),
      new AIMessage('gone'),
    ]);
    const items = [
      await buildMessageItem(context(client), 's1', '01A', live),
      await buildMessageItem(context(client), 's1', '01B', gone, NOW_SECONDS - 10),
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
          buildMessageItem(context(client), 's1', `01${i}${j}`, human),
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
