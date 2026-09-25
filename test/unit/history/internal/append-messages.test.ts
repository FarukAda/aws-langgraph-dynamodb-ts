import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { HumanMessage } from '@langchain/core/messages';

import { appendMessages } from '../../../../src/history/internal/append';
import { parseMessages, parseSessionId } from '../../../../src/history/internal/parse';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createUlidFactory } from '../../../../src/shared/ulid';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

describe('appendMessages', () => {
  it("writes a small append's messages and the SESSION update in one transaction", async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    const context = {
      client,
      tableName: 'history',
      serde: JSON_SERDE,
      logger: SILENT_LOGGER,
      ulid: createUlidFactory(),
      onCorruptMessage: 'skip',
    } as HistoryContext;

    await appendMessages(context, {
      sessionId: parseSessionId('s1'),
      messages: parseMessages([new HumanMessage('hello'), new HumanMessage('again')]),
      anchor: undefined,
      signal: undefined,
    });

    const calls = mock.commandCalls(TransactWriteCommand);
    expect(calls).toHaveLength(1);
    const items = calls[0].args[0].input.TransactItems ?? [];
    expect(items.map((item) => Object.keys(item)[0])).toEqual(['Update', 'Put', 'Put']);
  });
});
