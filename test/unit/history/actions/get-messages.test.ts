import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { mapChatMessagesToStoredMessages } from '@langchain/core/messages';

import { getMessages } from '../../../../src/history/actions/get-messages';
import { buildSessionItem } from '../../../../src/history/internal/item-mapper';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function context(client: HistoryContext['client']): HistoryContext {
  return { client, tableName: 'history', serde: JSON_SERDE, logger: SILENT_LOGGER };
}

describe('getMessages', () => {
  it('returns an empty array for an unknown session', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    expect(await getMessages(context(client), 'sess-x')).toEqual([]);
  });

  it('returns the decoded messages in order', async () => {
    const { client, mock } = createStrictDocumentMock();
    const stored = mapChatMessagesToStoredMessages([
      new HumanMessage('hi'),
      new AIMessage('hello'),
    ]);
    const item = await buildSessionItem(context(client), 'sess-1', stored, {
      version: 1,
      createdAt: 'c',
      updatedAt: 'u',
    });
    mock.on(GetCommand).resolves({ Item: item });
    const messages = await getMessages(context(client), 'sess-1');
    expect(messages.map((m) => m.content)).toEqual(['hi', 'hello']);
    expect(messages[0].getType()).toBe('human');
    expect(messages[1].getType()).toBe('ai');
  });
});
