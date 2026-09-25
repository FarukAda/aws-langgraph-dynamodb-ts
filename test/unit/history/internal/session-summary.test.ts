import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { parseSessionId } from '../../../../src/history/internal/parse';
import { sessionRowKey } from '../../../../src/history/internal/rows';
import { repairMessageCount, summariseSession } from '../../../../src/history/internal/session';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function context(client: HistoryContext['client']): HistoryContext {
  return { client, tableName: 'history', logger: SILENT_LOGGER } as never;
}

describe('summariseSession', () => {
  const row = {
    ...sessionRowKey('s1'),
    v: 1,
    sessionId: 's1',
    messageCount: 2,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
  };

  it('reads a SESSION row as its public summary', () => {
    expect(summariseSession(row, 0)).toEqual({
      sessionId: 's1',
      title: undefined,
      messageCount: 2,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
      expiresAt: undefined,
    });
  });

  it('reads nothing from a row whose count is not a number, or that has expired', () => {
    expect(summariseSession({ ...row, messageCount: '2' }, 0)).toBeUndefined();
    expect(summariseSession({ ...row, ttl: 10 }, 10)).toBeUndefined();
  });
});

describe('repairMessageCount', () => {
  it('writes the recounted number, pinned to the count it replaces', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { messageCount: 5 } });
    mock.on(QueryCommand).resolves({
      Items: [{ PK: 'HIST#s1', sessionId: 's1', message: { location: 'INLINE' }, v: 1 }],
    });
    mock.on(UpdateCommand).resolves({});

    await expect(repairMessageCount(context(client), parseSessionId('s1'))).resolves.toBe(1);

    const update = mock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(update.ExpressionAttributeValues).toEqual({ ':count': 1, ':expected': 5 });
  });
});
