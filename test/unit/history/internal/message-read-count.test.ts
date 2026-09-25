import { QueryCommand } from '@aws-sdk/lib-dynamodb';

import { countLiveMessages, readWindow } from '../../../../src/history/internal/message-read';
import { parseMessageWindow, parseSessionId } from '../../../../src/history/internal/parse';
import { messageSortKey } from '../../../../src/history/internal/rows';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import {
  MAX_LOOP_ITERATIONS,
  MAX_TOTAL_ITEMS_IN_MEMORY,
} from '../../../../src/shared/dynamodb/paginate';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
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
    onCorruptMessage: 'skip',
  };
}

/** `undefined` stands for an attribute the row does not carry, which DynamoDB never returns. */
type Row = Record<string, string | number | object | undefined>;

const NOW = Math.floor(FROZEN_NOW_MS / 1000);
const SESSION_ID = parseSessionId('s1');

/** A message row as this package writes it, optionally with a ttl and a format version. */
const message = (ulid: string, extra: { ttl?: number; v?: number } = {}): Row => ({
  PK: 'HIST#s1',
  SK: messageSortKey(ulid),
  sessionId: 's1',
  message: { location: 'INLINE', serdeType: 'json', schemaVersion: 1, compressed: false },
  ...extra,
});

/**
 * The attributes a projection names, as DynamoDB returns them: a document path
 * that does not resolve — because the attribute is absent, or is not a map —
 * is simply left out of the item rather than raising.
 */
function project(row: Row, projection: string, names: Record<string, string>): Row {
  const kept: Row = {};
  for (const token of projection.split(',')) {
    const [head, leaf] = token
      .trim()
      .split('.')
      .map((segment) => names[segment] ?? segment);
    if (row[head] === undefined) continue;
    if (leaf === undefined) {
      kept[head] = row[head];
      continue;
    }
    const nested = row[head] as Record<string, unknown>;
    if (typeof nested !== 'object' || nested === null || !(leaf in nested)) continue;
    kept[head] = { [leaf]: nested[leaf] };
  }
  return kept;
}

/**
 * Answer each page of the count's query as DynamoDB would. A `COUNT` select
 * returns only how many rows its ttl filter kept, and no rows at all; any other
 * request returns the rows, cut down to the attributes its projection names.
 */
function serve(mock: ReturnType<typeof createStrictDocumentMock>['mock'], pages: Row[][]) {
  let call = 0;
  mock.on(QueryCommand).callsFake((input) => {
    const rows = pages[call] ?? [];
    call += 1;
    const more = call < pages.length ? { LastEvaluatedKey: { PK: 'HIST#s1', SK: `p${call}` } } : {};
    if (input.Select === 'COUNT') {
      const now = input.ExpressionAttributeValues[':now'];
      const kept = rows.filter((row) => row.ttl === undefined || (row.ttl as number) > now);
      return { Count: kept.length, ...more };
    }
    const projection = String(input.ProjectionExpression ?? Object.keys(rows[0] ?? {}).join(','));
    const items = rows.map((row) => project(row, projection, input.ExpressionAttributeNames ?? {}));
    return { Items: items, ...more };
  });
}

describe('countLiveMessages', () => {
  it('counts only rows a reader would see', async () => {
    const { client, mock } = createStrictDocumentMock();
    serve(mock, [
      [
        message('01A'),
        message('01B', { v: 1 }),
        message('01C', { ttl: NOW }),
        message('01D', { ttl: NOW + 60 }),
      ],
    ]);
    await expect(countLiveMessages(context(client), SESSION_ID)).resolves.toBe(3);
  });

  /**
   * A session of offloaded or long messages costs no payload transfer to
   * count. The descriptor is reached by the one nested path that proves the
   * attribute is a map — never `#msg` whole, which would pull every inline
   * payload in the session across the wire.
   */
  it('asks for no message payload', async () => {
    const { client, mock } = createStrictDocumentMock();
    serve(mock, [[]]);
    await countLiveMessages(context(client), SESSION_ID);
    const input = mock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.ProjectionExpression).toBe('#pk, #sid, #msg.#loc, #v, #ttl');
    expect(input.ExpressionAttributeNames).toEqual({
      '#pk': 'PK',
      '#sk': 'SK',
      '#sid': 'sessionId',
      '#msg': 'message',
      '#loc': 'location',
      '#v': 'v',
      '#ttl': 'ttl',
    });
    expect(input.ExpressionAttributeValues?.[':pk']).toBe('HIST#s1');
  });

  it('sums every page, since a partial count is a wrong number', async () => {
    const { client, mock } = createStrictDocumentMock();
    serve(mock, [[message('01A'), message('01B')], [message('01C')]]);
    await expect(countLiveMessages(context(client), SESSION_ID)).resolves.toBe(3);
    expect(mock.commandCalls(QueryCommand)[1].args[0].input.ExclusiveStartKey).toEqual({
      PK: 'HIST#s1',
      SK: 'p1',
    });
  });

  // Uncapped: a count that stopped at the paginator's default would be a new, wrong number.
  it('counts past the default item cap in one page', async () => {
    const { client, mock } = createStrictDocumentMock();
    const rows = Array.from({ length: MAX_TOTAL_ITEMS_IN_MEMORY + 1 }, (_, index) =>
      message(`01${String(index).padStart(6, '0')}`),
    );
    serve(mock, [rows]);
    await expect(countLiveMessages(context(client), SESSION_ID)).resolves.toBe(
      MAX_TOTAL_ITEMS_IN_MEMORY + 1,
    );
  });

  it('follows every page past the default page cap', async () => {
    const { client, mock } = createStrictDocumentMock();
    serve(
      mock,
      Array.from({ length: MAX_LOOP_ITERATIONS + 1 }, (_, index) => [
        message(`01${String(index).padStart(6, '0')}`),
      ]),
    );
    await expect(countLiveMessages(context(client), SESSION_ID)).resolves.toBe(
      MAX_LOOP_ITERATIONS + 1,
    );
    expect(mock.commandCalls(QueryCommand)).toHaveLength(MAX_LOOP_ITERATIONS + 1);
  });

  // Bounded to 3 pages: if abort handling ever regressed, an unbounded fake
  // paired with the uncapped loop would resolve or reject the wrong way
  // rather than hang, so this test can never spin forever on its own.
  it('stops at the page boundary after the signal fires, sending no further query', async () => {
    const { client, mock } = createStrictDocumentMock();
    const controller = new AbortController();
    let call = 0;
    mock.on(QueryCommand).callsFake(() => {
      call += 1;
      if (call === 1) controller.abort();
      const more = call < 3 ? { LastEvaluatedKey: { PK: 'HIST#s1', SK: `p${call}` } } : {};
      return { Items: [message('01A')], ...more };
    });
    await expect(
      countLiveMessages(context(client), SESSION_ID, controller.signal),
    ).rejects.toMatchObject({ code: ErrorCode.ABORTED });
    expect(mock.commandCalls(QueryCommand)).toHaveLength(1);
  });

  it('answers zero for a session with no messages', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({});
    await expect(countLiveMessages(context(client), SESSION_ID)).resolves.toBe(0);
  });

  /**
   * The count is defined as what `getMessages` returns, and `getMessages`
   * refuses a message a newer release wrote. Counting that row would write a
   * number into `messageCount` that no reader of this release ever sees.
   */
  it('refuses a message row a newer release wrote, as the read path does', async () => {
    const { client, mock } = createStrictDocumentMock();
    const rows = [message('01A'), message('01B', { v: 2 })];
    serve(mock, [rows]);
    await expect(countLiveMessages(context(client), SESSION_ID)).rejects.toMatchObject({
      code: ErrorCode.FORMAT_UNSUPPORTED,
      context: { field: 'v' },
    });
    mock.reset();
    mock.on(QueryCommand).resolves({ Items: rows });
    await expect(
      readWindow(context(client), SESSION_ID, parseMessageWindow({})),
    ).rejects.toMatchObject({
      code: ErrorCode.FORMAT_UNSUPPORTED,
      context: { field: 'v' },
    });
  });

  /**
   * A row the read path refuses is not a row to count: `getMessages` answers
   * the whole session with a refusal, so a count that succeeded would write a
   * `messageCount` back onto a session no reader can open.
   */
  it.each([
    ['no sessionId', { sessionId: undefined }],
    ['a sessionId naming another session', { sessionId: 'other' }],
    ['no message attribute', { message: undefined }],
    ['a message attribute that is not a map', { message: 'x' }],
    ['a partition the sessionId disagrees with', { PK: 'HIST#other' }],
  ])('refuses a row with %s, as the read path does', async (_label, over) => {
    const { client, mock } = createStrictDocumentMock();
    const rows = [message('01A'), { ...message('01B'), ...over }];
    serve(mock, [rows]);
    await expect(countLiveMessages(context(client), SESSION_ID)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'message' },
    });
    mock.reset();
    mock.on(QueryCommand).resolves({ Items: rows });
    await expect(
      readWindow(context(client), SESSION_ID, parseMessageWindow({})),
    ).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'message' },
    });
  });

  /** Checked before the ttl, as `getMessages` checks it, so the clock cannot change the answer. */
  it('refuses a newer message row even when it has expired', async () => {
    const { client, mock } = createStrictDocumentMock();
    serve(mock, [[message('01A', { v: 2, ttl: NOW - 60 })]]);
    await expect(countLiveMessages(context(client), SESSION_ID)).rejects.toMatchObject({
      code: ErrorCode.FORMAT_UNSUPPORTED,
      context: { field: 'v' },
    });
  });
});
