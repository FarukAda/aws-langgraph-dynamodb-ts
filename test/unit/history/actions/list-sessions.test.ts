import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

import { listSessions } from '../../../../src/history/actions/list-sessions';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { DEFAULT_INDEX_SHARDS } from '../../../../src/shared/dynamodb/recency-index';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { MAX_PAGE_LIMIT } from '../../../../src/shared/validation/primitives';
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

/** A SESSION row keyed the way the adapter writes one: the partition carries the `HIST#` tag. */
const session = (sessionId: string, updatedAt: string, extra = {}) => ({
  PK: `HIST#${sessionId}`,
  SK: 'HISTORY#SESSION',
  sessionId,
  messageCount: 1,
  createdAt: '2024-01-01',
  updatedAt,
  ...extra,
});

describe('listSessions', () => {
  /**
   * The same call must not be checked on a table with the index and silently
   * accepted on one without it, and a caller who asks for ten sessions must not
   * be handed five thousand.
   */
  it('validates and honours the page options on the scan path too', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({
      Items: [
        session('a', '2026-01-03T00:00:00.000Z'),
        session('b', '2026-01-02T00:00:00.000Z'),
        session('c', '2026-01-01T00:00:00.000Z'),
      ],
    });
    const page = await listSessions(context(client), { limit: 2 });
    expect(page.sessions.map((s) => s.sessionId)).toEqual(['a', 'b']);
    expect(page.nextCursor).toBeUndefined();
    await expect(listSessions(context(client), { limit: -1 })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'limit' },
    });
    await expect(listSessions(context(client), { limit: 1.5 })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
    });
    await expect(listSessions(context(client), { limit: 1e12 })).rejects.toThrow(
      `limit must be <= ${MAX_PAGE_LIMIT}`,
    );
  });

  /**
   * A scan has to finish before the newest can be known, so answering
   * `limit: 0` by scanning and slicing to nothing would have paid for the whole
   * table to return an empty page. `limit: 0` used to be refused here.
   */
  it('answers a limit of zero with an empty page and reads nothing', async () => {
    const { client, mock } = createStrictDocumentMock();
    await expect(listSessions(context(client), { limit: 0 })).resolves.toEqual({ sessions: [] });
    expect(mock.commandCalls(ScanCommand)).toHaveLength(0);
  });

  /** A cursor names a position in an index that is not there; page one is the wrong answer. */
  it('refuses a cursor when the table has no recency index', async () => {
    const { client } = createStrictDocumentMock();
    await expect(listSessions(context(client), { cursor: 'abc' })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'cursor' },
    });
  });

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
    expect((await listSessions(context(client))).sessions.map((s) => s.sessionId)).toEqual([
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
    expect((await listSessions(context(client))).sessions.map((s) => s.sessionId).sort()).toEqual([
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
    expect((await listSessions(context(client))).sessions.map((s) => s.sessionId)).toEqual([
      'live',
    ]);
  });

  it('keeps a session whose ttl is still in the future (A1)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({
      Items: [session('live', '2026-01-01', { ttl: 4102444800 })],
    });
    expect((await listSessions(context(client))).sessions.map((s) => s.sessionId)).toEqual([
      'live',
    ]);
  });

  it('returns session metadata sorted by most recently updated', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({
      Items: [
        session('a', '2024-01-01', { title: 'A', messageCount: 2 }),
        session('b', '2024-02-01', { title: 'B', messageCount: 5 }),
      ],
    });
    const { sessions: sessions } = await listSessions(context(client));
    expect(sessions.map((s) => s.sessionId)).toEqual(['b', 'a']);
    expect(sessions[0]).toEqual({
      sessionId: 'b',
      title: 'B',
      messageCount: 5,
      createdAt: '2024-01-01',
      updatedAt: '2024-02-01',
    });
    const request = mock.commandCalls(ScanCommand)[0].args[0].input;
    expect(request.FilterExpression).toBe('begins_with(#pk, :pkp) AND #sk = :session');
    expect(request.ExpressionAttributeValues).toEqual({
      ':pkp': 'HIST#',
      ':session': 'HISTORY#SESSION',
    });
  });

  it('returns an empty list when there are no sessions', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [] });
    expect((await listSessions(context(client))).sessions).toEqual([]);
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
    const { sessions: sessions } = await listSessions(context(client));
    expect(sessions.map((s) => s.sessionId)).toEqual(['real']);
  });

  it('throws RESULT_TRUNCATED by default when scan pages are exhausted by non-session filtering', async () => {
    const { client, mock } = createStrictDocumentMock();
    // Every page returns 0 post-filter items but always continues (simulating
    // a table dominated by non-session rows), for more than MAX_LOOP_ITERATIONS (1000) pages.
    let scanMock = mock.on(ScanCommand);
    for (let i = 0; i < 1001; i++) {
      scanMock = scanMock.resolvesOnce({ Items: [], LastEvaluatedKey: { PK: 'x', SK: String(i) } });
    }
    await expect(listSessions(context(client))).rejects.toMatchObject({
      code: ErrorCode.RESULT_TRUNCATED,
    });
  });

  it('succeeds with a raised maxIterations override', async () => {
    const { client, mock } = createStrictDocumentMock();
    let scanMock = mock.on(ScanCommand);
    for (let i = 0; i < 1000; i++) {
      scanMock = scanMock.resolvesOnce({ Items: [], LastEvaluatedKey: { PK: 'x', SK: String(i) } });
    }
    scanMock.resolvesOnce({ Items: [session('s1', '2024-01-01')], LastEvaluatedKey: undefined });
    const { sessions: result } = await listSessions(context(client), { maxIterations: 2000 });
    expect(result.map((s) => s.sessionId)).toEqual(['s1']);
  });

  it('honors a maxItems override, truncating at a smaller cap than the default', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({
      Items: [session('a', '2024-01-01'), session('b', '2024-01-02')],
      LastEvaluatedKey: { PK: 'x', SK: 'y' },
    });
    await expect(listSessions(context(client), { maxItems: 1 })).rejects.toMatchObject({
      code: ErrorCode.RESULT_TRUNCATED,
    });
  });
});

describe('options shape (M-08)', () => {
  it('refuses a key this package does not read, naming it under options', async () => {
    const { client } = createStrictDocumentMock();
    await expect(
      listSessions(context(client), { limit: 1, bogus: true } as never),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'options.bogus' } });
  });

  it('refuses a signal that is not AbortSignal-like', async () => {
    const { client } = createStrictDocumentMock();
    await expect(listSessions(context(client), { signal: {} as never })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'signal' },
    });
  });

  it('refuses a non-integer maxItems or maxIterations, naming it', async () => {
    const { client } = createStrictDocumentMock();
    await expect(listSessions(context(client), { maxItems: 1.5 })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'maxItems' },
    });
    await expect(listSessions(context(client), { maxItems: null as never })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'maxItems' },
    });
    await expect(listSessions(context(client), { maxIterations: 1.5 })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'maxIterations' },
    });
    await expect(
      listSessions(context(client), { maxIterations: null as never }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'maxIterations' } });
  });

  /**
   * `Infinity` is the paginator's own documented way to ask for no cap
   * (`paginate.ts`'s `assertPositiveCap`) and must stay legal.
   */
  it('accepts Infinity for maxItems and maxIterations', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [] });
    await expect(listSessions(context(client), { maxItems: Infinity })).resolves.toEqual({
      sessions: [],
    });
    await expect(listSessions(context(client), { maxIterations: Infinity })).resolves.toEqual({
      sessions: [],
    });
  });
});

describe('SessionMetadata.expiresAt (HIST-18)', () => {
  it('exposes the stored ttl as an ISO instant and omits it when no ttl is stored', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({
      Items: [session('a', '2026-01-02', { ttl: 4102444800 }), session('b', '2026-01-01')],
    });
    const { sessions: sessions } = await listSessions(context(client));
    expect(sessions[0].expiresAt).toBe('2100-01-01T00:00:00.000Z');
    expect(sessions[1].expiresAt).toBeUndefined();
  });
});

describe('listSessions uses the recency index when the table has one (HIST-10)', () => {
  function indexed(client: Parameters<typeof context>[0]) {
    return { ...context(client), indexName: 'gsi1', indexShards: 2 } as never;
  }

  const sessionRow = (id: string, at: string) => ({
    PK: `HIST#${id}`,
    SK: 'HISTORY#SESSION',
    sessionId: id,
    messageCount: 1,
    createdAt: at,
    updatedAt: at,
    gsi1pk: 'SESS#0',
    gsi1sk: `${at}#${id}`,
  });

  /**
   * The scan read capacity for every row it *evaluated*, held every session in
   * memory and sorted there, and offered no cursor — for what is the session
   * list of a chat application.
   */
  it('queries the index instead of scanning the table', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [sessionRow('a', '2026-01-01T00:00:00Z')] });
    const page = await listSessions(indexed(client), { limit: 5 });
    expect(page.sessions.map((s) => s.sessionId)).toEqual(['a', 'a']);
    expect(mock.commandCalls(ScanCommand)).toHaveLength(0);
  });

  it('drops expired and foreign rows the index still points at', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({
      Items: [
        { ...sessionRow('live', '2026-01-02T00:00:00Z') },
        { ...sessionRow('gone', '2026-01-01T00:00:00Z'), ttl: 1 },
        { PK: 'X', SK: 'OTHER', gsi1sk: '2026-01-03T00:00:00Z#x' },
      ],
    });
    const page = await listSessions(indexed(client), { limit: 10 });
    expect(page.sessions.map((s) => s.sessionId)).toEqual(['live', 'live']);
  });

  /**
   * A table indexed without a shard count is read on the same default the
   * writers stamp, and a caller who names no page size gets the default one.
   */
  it('queries every default shard when neither indexShards nor a limit is given', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    const ctx = { ...context(client), indexName: 'gsi1' } as never;

    const page = await listSessions(ctx);

    expect(page).toEqual({ sessions: [] });
    const calls = mock.commandCalls(QueryCommand);
    const partitions = calls.map(
      (call) => call.args[0].input.ExpressionAttributeValues?.[':pk'] as string,
    );
    expect(new Set(partitions).size).toBe(DEFAULT_INDEX_SHARDS);
    expect(calls[0].args[0].input.Limit).toBe(100);
  });

  /**
   * The cursor is the position in the index, so it advances whenever rows
   * remain — even if expiry and foreign rows left fewer sessions behind.
   */
  it('hands back a cursor while rows remain', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({
      Items: [sessionRow('b', '2026-01-02T00:00:00Z'), sessionRow('a', '2026-01-01T00:00:00Z')],
    });

    const page = await listSessions(indexed(client), { limit: 2 });

    expect(page.sessions.map((session) => session.sessionId)).toEqual(['b', 'b']);
    expect(typeof page.nextCursor).toBe('string');
  });

  it('falls back to the scan when no index is configured', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [sessionRow('a', '2026-01-01T00:00:00Z')] });
    const page = await listSessions(context(client));
    expect(page.sessions.map((s) => s.sessionId)).toEqual(['a']);
    expect(page.nextCursor).toBeUndefined();
    expect(mock.commandCalls(QueryCommand)).toHaveLength(0);
  });
});
