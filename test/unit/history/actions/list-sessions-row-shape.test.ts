import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

import { listSessions } from '../../../../src/history/actions/list-sessions';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function context(client: HistoryContext['client'], indexed: boolean): HistoryContext {
  return {
    client,
    tableName: 'history',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    ulid: () => 'U',
    onCorruptMessage: 'skip',
    ...(indexed ? { indexName: 'gsi1', indexShards: 1 } : {}),
  };
}

/** A SESSION row as this package writes it, with the index keys a listing reads it by. */
const sessionRow = (id: string, at: string, extra: Record<string, unknown> = {}) => ({
  PK: `HIST#${id}`,
  SK: 'HISTORY#SESSION',
  sessionId: id,
  messageCount: 1,
  createdAt: at,
  updatedAt: at,
  gsi1pk: 'SESS#0',
  gsi1sk: `${at}#${id}`,
  ...extra,
});

/** Answer the listing's read, whichever path it takes, with `items`. */
function serve(mock: ReturnType<typeof createStrictDocumentMock>['mock'], items: object[]) {
  mock.on(ScanCommand).resolves({ Items: items });
  mock.on(QueryCommand).resolves({ Items: items });
}

/** The ids `listSessions` hands back over `items`, on whichever path `indexed` selects. */
async function idsOver(indexed: boolean, items: object[]): Promise<string[]> {
  const { client, mock } = createStrictDocumentMock();
  serve(mock, items);
  const page = await listSessions(context(client, indexed), { limit: 50 });
  return page.sessions.map((session) => session.sessionId);
}

/**
 * A SESSION row holds whatever its writer stored, and `expiresAt` is rendered
 * from the row's own `ttl`. A `ttl` the expiry check cannot judge survives that
 * check — `'soon' <= now` is `false`, so the row reads as live — and reaches
 * `new Date(...).toISOString()`, which raised a `RangeError` out of the whole
 * listing. One unreadable row took every healthy session with it.
 */
describe.each([
  ['the scan', false],
  ['the recency index', true],
])('listSessions through %s', (_path, indexed) => {
  it('returns the healthy sessions when one row carries a ttl that is not a number', async () => {
    const ids = await idsOver(indexed, [
      sessionRow('first', '2026-01-03T00:00:00Z'),
      sessionRow('rotten', '2026-01-02T00:00:00Z', { ttl: 'soon' }),
      sessionRow('second', '2026-01-01T00:00:00Z'),
    ]);

    expect(ids).toEqual(['first', 'second']);
  });

  /**
   * `typeof x === 'number'` is not the test: `NaN`, `Infinity` and a value past
   * the ±8.64e12 seconds a `Date` spans are all numbers, and `toISOString`
   * throws for every one of them.
   */
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a second past the range a Date spans', 8.64e12 + 1],
  ])('skips a row whose ttl is %s, keeping the rest', async (_label, ttl) => {
    const ids = await idsOver(indexed, [
      sessionRow('rotten', '2026-01-02T00:00:00Z', { ttl }),
      sessionRow('healthy', '2026-01-01T00:00:00Z'),
    ]);

    expect(ids).toEqual(['healthy']);
  });

  /**
   * The summary hands each of these straight back under a declared type, so a
   * row whose attribute disagrees with it returns a lie rather than throwing.
   * It is the same defect answered the same way: the row is not one this
   * release can speak for, so it is not in the page.
   */
  it.each([
    ['messageCount', { messageCount: 'many' }],
    ['createdAt', { createdAt: 1_700_000_000 }],
    ['updatedAt', { updatedAt: null }],
    ['title', { title: 42 }],
  ])('skips a row whose %s is not the type this package writes', async (_field, over) => {
    const ids = await idsOver(indexed, [
      sessionRow('rotten', '2026-01-02T00:00:00Z', over),
      sessionRow('healthy', '2026-01-01T00:00:00Z'),
    ]);

    expect(ids).toEqual(['healthy']);
  });

  /**
   * Neither read selects rows by partition — the scan filters on the sort key
   * and the index query reads a shard — so a row planted anywhere in the table
   * under this adapter's SESSION sort key reaches the summary. Binding its
   * `sessionId` to the partition it lives in is what keeps it from being
   * handed back as a session whose messages live somewhere else entirely.
   */
  it.each([
    ['a partition belonging to another session', { PK: 'HIST#other' }],
    ['a partition belonging to another adapter', { PK: 'CHKPT#t1' }],
    ['no partition key at all', { PK: undefined }],
  ])('skips a row claiming a sessionId that disagrees with %s', async (_label, over) => {
    const ids = await idsOver(indexed, [
      sessionRow('planted', '2026-01-02T00:00:00Z', over),
      sessionRow('healthy', '2026-01-01T00:00:00Z'),
    ]);

    expect(ids).toEqual(['healthy']);
  });

  /** The ttl this package does write still resolves to the instant it names. */
  it('still renders a well-formed ttl as an ISO instant', async () => {
    const { client, mock } = createStrictDocumentMock();
    serve(mock, [sessionRow('live', '2026-01-01T00:00:00Z', { ttl: 4102444800 })]);

    const page = await listSessions(context(client, indexed), { limit: 50 });

    expect(page.sessions[0].expiresAt).toBe('2100-01-01T00:00:00.000Z');
  });
});
