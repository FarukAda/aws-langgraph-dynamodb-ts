import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { AIMessage, HumanMessage, mapChatMessagesToStoredMessages } from '@langchain/core/messages';

import { getMessages } from '../../../../src/history/actions/get-messages';
import { parseSessionId } from '../../../../src/history/internal/parse';
import { buildMessageItem } from '../../../../src/history/internal/rows';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { overlapOffloader } from '../../../shared/helpers/offload-overlap';

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

const SESSION_ID = parseSessionId('s1');

describe('offloaded reads run concurrently (CODEC-14)', () => {
  it('decodes offloaded messages up to 8 at a time, preserving order', async () => {
    const { client, mock } = createStrictDocumentMock();
    const { offloader, maxInFlight } = overlapOffloader();
    const ctx = context(client, { offloader: offloader as never });
    const stored = mapChatMessagesToStoredMessages([
      new HumanMessage('m0'),
      new AIMessage('m1'),
      new HumanMessage('m2'),
      new AIMessage('m3'),
    ]);
    const items = await Promise.all(
      stored.map((message, index) =>
        buildMessageItem(ctx, { sessionId: SESSION_ID, messageId: `01${index}`, message }),
      ),
    );
    mock.on(QueryCommand).resolves({ Items: items });
    const messages = await getMessages(ctx, 's1');
    expect(messages.map((message) => message.content)).toEqual(['m0', 'm1', 'm2', 'm3']);
    expect(maxInFlight()).toBeGreaterThan(1);
    expect(maxInFlight()).toBeLessThanOrEqual(8);
  });

  /**
   * `readConcurrency` is the multiplier on this package's memory ceiling: one
   * call holds that many payloads at once, each with its downloaded and its
   * decompressed form resident. An option that is accepted but ignored would
   * make the ceiling unenforceable, so the fan-out is measured, not assumed.
   */
  it('never decodes more at once than readConcurrency allows', async () => {
    const { client, mock } = createStrictDocumentMock();
    const { offloader, maxInFlight } = overlapOffloader();
    const ctx = context(client, { offloader: offloader as never, readConcurrency: 2 });
    const stored = mapChatMessagesToStoredMessages([
      new HumanMessage('m0'),
      new AIMessage('m1'),
      new HumanMessage('m2'),
      new AIMessage('m3'),
      new HumanMessage('m4'),
      new AIMessage('m5'),
    ]);
    const items = await Promise.all(
      stored.map((message, index) =>
        buildMessageItem(ctx, { sessionId: SESSION_ID, messageId: `01${index}`, message }),
      ),
    );
    mock.on(QueryCommand).resolves({ Items: items });

    const messages = await getMessages(ctx, 's1');

    expect(messages.map((message) => message.content)).toEqual([
      'm0',
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
    ]);
    expect(maxInFlight()).toBe(2);
  });
});
