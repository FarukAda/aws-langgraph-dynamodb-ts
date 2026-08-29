import type { StoredMessage } from '@langchain/core/messages';

import { buildMessageItem, decodeMessageItem } from '../../../../src/history/internal/item-mapper';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';

function context(): HistoryContext {
  return {
    client: {} as never,
    tableName: 'history',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    ulid: () => 'U',
  };
}

const stored: StoredMessage = { type: 'human', data: { content: 'hi' } } as StoredMessage;

describe('history item-mapper', () => {
  it('builds a message item with PK/SK and round-trips the message', async () => {
    const item = await buildMessageItem(context(), 's1', '01HZX', stored);
    expect(item.PK).toBe('HIST#s1');
    expect(item.SK).toBe('HISTORY#MSG#01HZX');
    expect(item.sessionId).toBe('s1');
    expect(item.ttl).toBeUndefined();
    expect(await decodeMessageItem(context(), item)).toEqual(stored);
  });

  it('stamps a ttl when provided', async () => {
    const item = await buildMessageItem(context(), 's1', '01HZX', stored, 1750);
    expect(item.ttl).toBe(1750);
  });
});
