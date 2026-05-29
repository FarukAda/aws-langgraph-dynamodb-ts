import { ScanCommand } from '@aws-sdk/lib-dynamodb';

import { listSessions } from '../../../../src/history/actions/list-sessions';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function context(client: HistoryContext['client']): HistoryContext {
  return { client, tableName: 'history', serde: JSON_SERDE, logger: SILENT_LOGGER };
}

describe('listSessions', () => {
  it('returns session metadata sorted by most recently updated', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({
      Items: [
        {
          sessionId: 'a',
          title: 'A',
          messageCount: 2,
          createdAt: '2024-01-01',
          updatedAt: '2024-01-01',
        },
        {
          sessionId: 'b',
          title: 'B',
          messageCount: 5,
          createdAt: '2024-01-02',
          updatedAt: '2024-02-01',
        },
      ],
    });
    const sessions = await listSessions(context(client));
    expect(sessions.map((s) => s.sessionId)).toEqual(['b', 'a']);
    expect(sessions[0]).toEqual({
      sessionId: 'b',
      title: 'B',
      messageCount: 5,
      createdAt: '2024-01-02',
      updatedAt: '2024-02-01',
    });
  });

  it('returns an empty list when there are no sessions', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [] });
    expect(await listSessions(context(client))).toEqual([]);
  });
});
