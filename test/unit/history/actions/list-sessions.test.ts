import { ScanCommand } from '@aws-sdk/lib-dynamodb';

import { listSessions } from '../../../../src/history/actions/list-sessions';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ResultTruncatedError } from '../../../../src/shared/errors/errors';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

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

const session = (sessionId: string, updatedAt: string, extra = {}) => ({
  PK: sessionId,
  SK: 'HISTORY#SESSION',
  sessionId,
  messageCount: 1,
  createdAt: '2024-01-01',
  updatedAt,
  ...extra,
});

describe('listSessions', () => {
  it('orders by ordinal comparison on the ISO timestamp, not locale rules (M15)', async () => {
    const { client, mock } = createStrictDocumentMock();
    // Scanned in a mixed order so the comparator is exercised in both
    // directions, not just ascending input.
    mock.on(ScanCommand).resolves({
      Items: [
        session('mid', '2026-01-02T00:00:00.000Z'),
        session('newest', '2026-01-03T00:00:00.000Z'),
        session('oldest', '2026-01-01T00:00:00.000Z'),
      ],
    });
    expect((await listSessions(context(client))).map((s) => s.sessionId)).toEqual([
      'newest',
      'mid',
      'oldest',
    ]);
  });

  it('keeps both sessions when their timestamps tie (M15)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({
      Items: [session('a', '2026-01-01T00:00:00.000Z'), session('b', '2026-01-01T00:00:00.000Z')],
    });
    expect((await listSessions(context(client))).map((s) => s.sessionId).sort()).toEqual([
      'a',
      'b',
    ]);
  });

  it('omits a session whose ttl has already passed, matching getMessages (A1)', async () => {
    // getMessages filters expired messages on read because DynamoDB's own TTL
    // sweep lags up to 48h; listSessions did not, so an expired session kept
    // appearing in listings after its messages had vanished from reads.
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({
      Items: [session('live', '2026-01-01'), session('dead', '2026-01-02', { ttl: 1 })],
    });
    expect((await listSessions(context(client))).map((s) => s.sessionId)).toEqual(['live']);
  });

  it('keeps a session whose ttl is still in the future (A1)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({
      Items: [session('live', '2026-01-01', { ttl: 4102444800 })],
    });
    expect((await listSessions(context(client))).map((s) => s.sessionId)).toEqual(['live']);
  });

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
        // A bare 'SESSION' SK with no sessionId — exactly what a store item at
        // store.put([id], 'SESSION', ...) looks like on a shared table (the I9
        // collision this adapter's HISTORY# prefix now avoids at the PK/SK
        // level; this asserts the read-side filter also treats it as foreign).
        { PK: 'ns', SK: 'SESSION', namespace: ['ns'] },
        session('real', '2024-03-01'),
      ],
    });
    const sessions = await listSessions(context(client));
    expect(sessions.map((s) => s.sessionId)).toEqual(['real']);
  });

  it('throws ResultTruncatedError by default when scan pages are exhausted by non-session filtering', async () => {
    const { client, mock } = createStrictDocumentMock();
    // Every page returns 0 post-filter items but always continues (simulating
    // a table dominated by non-session rows), for more than MAX_LOOP_ITERATIONS (1000) pages.
    let scanMock = mock.on(ScanCommand);
    for (let i = 0; i < 1001; i++) {
      scanMock = scanMock.resolvesOnce({ Items: [], LastEvaluatedKey: { PK: 'x', SK: String(i) } });
    }
    await expect(listSessions(context(client))).rejects.toThrow(ResultTruncatedError);
  });

  it('succeeds with a raised maxIterations override', async () => {
    const { client, mock } = createStrictDocumentMock();
    let scanMock = mock.on(ScanCommand);
    for (let i = 0; i < 1000; i++) {
      scanMock = scanMock.resolvesOnce({ Items: [], LastEvaluatedKey: { PK: 'x', SK: String(i) } });
    }
    scanMock.resolvesOnce({ Items: [session('s1', '2024-01-01')], LastEvaluatedKey: undefined });
    const result = await listSessions(context(client), { maxIterations: 2000 });
    expect(result.map((s) => s.sessionId)).toEqual(['s1']);
  });

  it('honors a maxItems override, truncating at a smaller cap than the default', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({
      Items: [session('a', '2024-01-01'), session('b', '2024-01-02')],
      LastEvaluatedKey: { PK: 'x', SK: 'y' },
    });
    await expect(listSessions(context(client), { maxItems: 1 })).rejects.toThrow(
      ResultTruncatedError,
    );
  });
});
