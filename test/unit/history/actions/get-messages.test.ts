import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { AIMessage, HumanMessage, mapChatMessagesToStoredMessages } from '@langchain/core/messages';

import { getMessages } from '../../../../src/history/actions/get-messages';
import { buildMessageItem } from '../../../../src/history/internal/item-mapper';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { FROZEN_NOW_MS } from '../../../shared/helpers/test-setup';

function context(client: HistoryContext['client']): HistoryContext {
  return {
    client,
    tableName: 'history',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    ulid: () => 'U',
  };
}

const NOW_SECONDS = Math.floor(FROZEN_NOW_MS / 1000);

describe('getMessages', () => {
  it('returns an empty array for a session with no messages', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    expect(await getMessages(context(client), 'sess-x')).toEqual([]);
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
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 's1', ':skp': 'MSG#' });
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
});
