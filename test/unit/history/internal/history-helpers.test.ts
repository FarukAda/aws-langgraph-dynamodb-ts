import { QueryCommand } from '@aws-sdk/lib-dynamodb';

import {
  isHistorySortKey,
  messageSortKey,
  SESSION_SORT_KEY,
} from '../../../../src/history/internal/keys';
import { readWindow } from '../../../../src/history/internal/message-window';
import { parseMessageWindow, parseSessionId } from '../../../../src/history/internal/parse';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
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

const SESSION_ID = parseSessionId('s1');

const row = (ulid: string, ttl?: number) => ({
  PK: 'HIST#s1',
  SK: messageSortKey(ulid),
  sessionId: 's1',
  message: { location: 'INLINE', serdeType: 'json', schemaVersion: 1, compressed: false },
  ...(ttl === undefined ? {} : { ttl }),
});

describe('isHistorySortKey', () => {
  it('owns its message and session rows and nothing else', () => {
    expect(isHistorySortKey(SESSION_SORT_KEY)).toBe(true);
    expect(isHistorySortKey(messageSortKey('01J'))).toBe(true);
    expect(isHistorySortKey('META##c1')).toBe(false);
    expect(isHistorySortKey('u1#profile')).toBe(false);
    expect(isHistorySortKey('HISTORY')).toBe(false);
  });
});

describe('readWindow', () => {
  it('reads the whole session oldest-first when no limit is given', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [row('01A'), row('01B')] });
    const items = await readWindow(context(client), SESSION_ID, parseMessageWindow({}));
    expect(items.map((item) => item.SK)).toEqual([messageSortKey('01A'), messageSortKey('01B')]);
    expect(mock.commandCalls(QueryCommand)[0].args[0].input.ScanIndexForward).toBe(true);
  });

  /** A tail window walks newest-first and is reversed back into chronological order. */
  it('walks newest-first for a limit and returns the tail in order', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [row('01C'), row('01B')] });
    const items = await readWindow(context(client), SESSION_ID, parseMessageWindow({ limit: 2 }));
    expect(items.map((item) => item.SK)).toEqual([messageSortKey('01B'), messageSortKey('01C')]);
    expect(mock.commandCalls(QueryCommand)[0].args[0].input.ScanIndexForward).toBe(false);
  });

  /** Expired rows are skipped here, so a page can come back short and the walk continues. */
  it('skips a row past its ttl, whatever DynamoDB still holds', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [row('01A', 1), row('01B')] });
    const items = await readWindow(context(client), SESSION_ID, parseMessageWindow({}));
    expect(items.map((item) => item.SK)).toEqual([messageSortKey('01B')]);
  });

  it('bounds the read with `before` as an exclusive upper sort key', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    await readWindow(
      context(client),
      SESSION_ID,
      parseMessageWindow({ before: new Date('2026-01-01T00:00:00.000Z') }),
    );
    const values = mock.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues;
    expect(String(values?.[':before'])).toContain('HISTORY#MSG#');
  });

  /** A read-your-writes guarantee: the turn just appended is visible to the very next read. */
  it('reads strongly consistently', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    await readWindow(context(client), SESSION_ID, parseMessageWindow({}));
    expect(mock.commandCalls(QueryCommand)[0].args[0].input.ConsistentRead).toBe(true);
  });

  it('fails loudly for a row a newer release wrote rather than hiding it', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [{ ...row('01A'), v: 99 }] });
    await expect(readWindow(context(client), SESSION_ID, parseMessageWindow({}))).rejects.toThrow(
      /format version 99/,
    );
  });
});
