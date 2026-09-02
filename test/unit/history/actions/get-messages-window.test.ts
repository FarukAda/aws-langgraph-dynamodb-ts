import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { AIMessage, HumanMessage, mapChatMessagesToStoredMessages } from '@langchain/core/messages';

import { getMessages } from '../../../../src/history/actions/get-messages';
import { buildMessageItem } from '../../../../src/history/internal/item-mapper';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import type { ChatMessageItem } from '../../../../src/history/types';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { ulidTimePrefix } from '../../../../src/shared/ulid';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { FROZEN_NOW_MS } from '../../../shared/helpers/test-setup';

function context(client: HistoryContext['client']): HistoryContext {
  return {
    client,
    tableName: 'history',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    ulid: () => 'U',
    onCorruptMessage: 'skip',
  };
}

const NOW_SECONDS = Math.floor(FROZEN_NOW_MS / 1000);

/** Message items m0..mN-1 in chronological order; `expired` names the ones already past their TTL. */
async function items(
  client: HistoryContext['client'],
  count: number,
  expired: readonly number[] = [],
): Promise<ChatMessageItem[]> {
  const stored = mapChatMessagesToStoredMessages(
    Array.from({ length: count }, (_, i) =>
      i % 2 === 0 ? new HumanMessage(`m${i}`) : new AIMessage(`m${i}`),
    ),
  );
  return Promise.all(
    stored.map((message, i) =>
      buildMessageItem(
        context(client),
        's1',
        `01${i}`,
        message,
        expired.includes(i) ? NOW_SECONDS - 10 : undefined,
      ),
    ),
  );
}

describe('getMessages window (HIST-06)', () => {
  it('returns the newest `limit` messages in chronological order, reading the tail newest-first', async () => {
    const { client, mock } = createStrictDocumentMock();
    const all = await items(client, 4);
    mock.on(QueryCommand).callsFake((input) => ({
      Items: [...all].reverse().slice(0, input.Limit as number),
    }));
    const messages = await getMessages(context(client), 's1', { limit: 2 });
    expect(messages.map((m) => m.content)).toEqual(['m2', 'm3']);
    const input = mock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.ScanIndexForward).toBe(false);
    expect(input.Limit).toBe(2);
    expect(input.ConsistentRead).toBe(true);
  });

  it('keeps reading past expired rows until `limit` live messages are in hand, then stops', async () => {
    const { client, mock } = createStrictDocumentMock();
    const all = await items(client, 4, [3]);
    const newestFirst = [...all].reverse();
    let pages = 0;
    mock.on(QueryCommand).callsFake((input) => {
      pages += 1;
      const limit = input.Limit as number;
      const start = (pages - 1) * limit;
      const page = newestFirst.slice(start, start + limit);
      return {
        Items: page,
        LastEvaluatedKey:
          start + limit < newestFirst.length ? { PK: 'x', SK: String(pages) } : undefined,
      };
    });
    const messages = await getMessages(context(client), 's1', { limit: 2 });
    expect(messages.map((m) => m.content)).toEqual(['m1', 'm2']);
    expect(pages).toBe(2);
  });

  it('bounds the read to messages before `before` via an exclusive sort-key bound', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: await items(client, 2) });
    await getMessages(context(client), 's1', { before: new Date(FROZEN_NOW_MS) });
    const input = mock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.KeyConditionExpression).toBe('#pk = :pk AND #sk BETWEEN :skp AND :before');
    expect(input.ExpressionAttributeValues).toEqual({
      ':pk': 'HIST#s1',
      ':skp': 'HISTORY#MSG#',
      ':before': `HISTORY#MSG#${ulidTimePrefix(FROZEN_NOW_MS)}`,
    });
    expect(input.ScanIndexForward).toBe(true);
    expect(input.Limit).toBeUndefined();
  });

  it('reads the whole session, oldest-first and uncapped, when no window is given', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: await items(client, 3) });
    const messages = await getMessages(context(client), 's1');
    expect(messages.map((m) => m.content)).toEqual(['m0', 'm1', 'm2']);
    const input = mock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.Limit).toBeUndefined();
    expect(input.KeyConditionExpression).toBe('#pk = :pk AND begins_with(#sk, :skp)');
  });

  it('rejects an invalid window before reaching DynamoDB', async () => {
    const { client, mock } = createStrictDocumentMock();
    for (const window of [
      { limit: 0 },
      { limit: 1.5 },
      { before: new Date('nope') },
      { before: '2024-01-01' as never },
    ]) {
      await expect(getMessages(context(client), 's1', window)).rejects.toMatchObject({
        code: ErrorCode.VALIDATION,
      });
    }
    expect(mock.commandCalls(QueryCommand)).toHaveLength(0);
  });
});
