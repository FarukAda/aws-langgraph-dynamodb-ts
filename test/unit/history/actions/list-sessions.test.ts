import { ScanCommand } from '@aws-sdk/lib-dynamodb';

import { listSessions } from '../../../../src/history/actions/list-sessions';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function context(client: HistoryContext['client']): HistoryContext {
  return { client, tableName: 'history', serde: JSON_SERDE, logger: SILENT_LOGGER };
}

const session = (sessionId: string, updatedAt: string, extra = {}) => ({
  PK: sessionId,
  SK: 'SESSION',
  sessionId,
  messageCount: 1,
  createdAt: '2024-01-01',
  updatedAt,
  ...extra,
});

describe('listSessions', () => {
  it('returns session metadata sorted by most recently updated', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({
      Items: [
        session('a', '2024-01-01', { title: 'A', messageCount: 2 }),
        session('b', '2024-02-01', { title: 'B', messageCount: 5 }),
      ],
    });
    const sessions = await listSessions(context(client));
    expect(sessions.map((s) => s.sessionId)).toEqual(['b', 'a']);
    expect(sessions[0]).toEqual({
      sessionId: 'b',
      title: 'B',
      messageCount: 5,
      createdAt: '2024-01-01',
      updatedAt: '2024-02-01',
    });
    expect(mock.commandCalls(ScanCommand)[0].args[0].input.FilterExpression).toBe('#sk = :session');
  });

  it('returns an empty list when there are no sessions', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [] });
    expect(await listSessions(context(client))).toEqual([]);
  });

  it('skips foreign rows on a shared table (no crash on missing fields)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({
      Items: [
        { PK: 'thread', SK: 'META##c' },
        { PK: 'ns', SK: 'SESSION', namespace: ['ns'] },
        session('real', '2024-03-01'),
      ],
    });
    const sessions = await listSessions(context(client));
    expect(sessions.map((s) => s.sessionId)).toEqual(['real']);
  });
});
