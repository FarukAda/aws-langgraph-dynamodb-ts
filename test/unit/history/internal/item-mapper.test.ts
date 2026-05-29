import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { StoredMessage } from '@langchain/core/messages';

import {
  buildSessionItem,
  decodeMessages,
  readRawSession,
} from '../../../../src/history/internal/item-mapper';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function context(client: HistoryContext['client']): HistoryContext {
  return { client, tableName: 'history', serde: JSON_SERDE, logger: SILENT_LOGGER };
}

const messages: StoredMessage[] = [
  { type: 'human', data: { content: 'hi' } } as StoredMessage,
  { type: 'ai', data: { content: 'hello' } } as StoredMessage,
];

describe('history item-mapper', () => {
  it('builds a session item and round-trips the messages', async () => {
    const item = await buildSessionItem(context({} as never), 'sess-1', messages, {
      version: 1,
      createdAt: 'c',
      updatedAt: 'u',
      title: 'hi',
    });
    expect(item.PK).toBe('sess-1');
    expect(item.SK).toBe('SESSION');
    expect(item.messageCount).toBe(2);
    expect(item.version).toBe(1);
    expect(item.title).toBe('hi');
    expect(await decodeMessages(context({} as never), item)).toEqual(messages);
  });

  it('omits title and ttl when not provided', async () => {
    const item = await buildSessionItem(context({} as never), 's', [], {
      version: 0,
      createdAt: 'c',
      updatedAt: 'u',
    });
    expect(item.title).toBeUndefined();
    expect(item.ttl).toBeUndefined();
  });

  it('stamps a ttl when provided', async () => {
    const item = await buildSessionItem(context({} as never), 's', messages, {
      version: 2,
      createdAt: 'c',
      updatedAt: 'u',
      ttlTimestamp: 1750,
    });
    expect(item.ttl).toBe(1750);
  });

  it('reads a raw session item by key, returning undefined when absent', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { sessionId: 'sess-1', version: 3 } });
    const item = await readRawSession(context(client), 'sess-1');
    expect(item?.version).toBe(3);
    expect(mock.commandCalls(GetCommand)[0].args[0].input.Key).toEqual({
      PK: 'sess-1',
      SK: 'SESSION',
    });

    const empty = createStrictDocumentMock();
    empty.mock.on(GetCommand).resolves({});
    expect(await readRawSession(context(empty.client), 'x')).toBeUndefined();
  });
});
