import { QueryCommand } from '@aws-sdk/lib-dynamodb';

import { messageSortKey } from '../../../../src/history/internal/keys';
import { countLiveMessages } from '../../../../src/history/internal/message-count';
import { readWindow } from '../../../../src/history/internal/message-window';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
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
  } as HistoryContext;
}

type Row = Record<string, string | number | object>;

const NOW = Math.floor(FROZEN_NOW_MS / 1000);

/** A message row as this package writes it, optionally with a ttl and a format version. */
const message = (ulid: string, extra: { ttl?: number; v?: number } = {}): Row => ({
  PK: 'HIST#s1',
  SK: messageSortKey(ulid),
  sessionId: 's1',
  message: { location: 'INLINE', serdeType: 'json', schemaVersion: 1, compressed: false },
  ...extra,
});

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
    const names = String(input.ProjectionExpression ?? Object.keys(rows[0] ?? {}).join(','))
      .split(',')
      .map((token) => input.ExpressionAttributeNames?.[token.trim()] ?? token.trim());
    const items = rows.map((row) =>
      Object.fromEntries(names.filter((name) => name in row).map((name) => [name, row[name]])),
    );
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
    await expect(countLiveMessages(context(client), 's1')).resolves.toBe(3);
  });

  /** A session of offloaded or long messages costs no payload transfer to count. */
  it('asks for no message payload', async () => {
    const { client, mock } = createStrictDocumentMock();
    serve(mock, [[]]);
    await countLiveMessages(context(client), 's1');
    const input = mock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.ProjectionExpression).toBe('#v, #ttl');
    expect(input.ExpressionAttributeNames).toEqual({
      '#pk': 'PK',
      '#sk': 'SK',
      '#v': 'v',
      '#ttl': 'ttl',
    });
    expect(input.ExpressionAttributeValues?.[':pk']).toBe('HIST#s1');
  });

  it('sums every page, since a partial count is a wrong number', async () => {
    const { client, mock } = createStrictDocumentMock();
    serve(mock, [[message('01A'), message('01B')], [message('01C')]]);
    await expect(countLiveMessages(context(client), 's1')).resolves.toBe(3);
    expect(mock.commandCalls(QueryCommand)[1].args[0].input.ExclusiveStartKey).toEqual({
      PK: 'HIST#s1',
      SK: 'p1',
    });
  });

  it('answers zero for a session with no messages', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({});
    await expect(countLiveMessages(context(client), 's1')).resolves.toBe(0);
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
    await expect(countLiveMessages(context(client), 's1')).rejects.toMatchObject({
      code: ErrorCode.FORMAT_UNSUPPORTED,
      context: { field: 'v' },
    });
    mock.reset();
    mock.on(QueryCommand).resolves({ Items: rows });
    await expect(readWindow(context(client), 's1', {})).rejects.toMatchObject({
      code: ErrorCode.FORMAT_UNSUPPORTED,
      context: { field: 'v' },
    });
  });

  /** Checked before the ttl, as `getMessages` checks it, so the clock cannot change the answer. */
  it('refuses a newer message row even when it has expired', async () => {
    const { client, mock } = createStrictDocumentMock();
    serve(mock, [[message('01A', { v: 2, ttl: NOW - 60 })]]);
    await expect(countLiveMessages(context(client), 's1')).rejects.toMatchObject({
      code: ErrorCode.FORMAT_UNSUPPORTED,
      context: { field: 'v' },
    });
  });
});
