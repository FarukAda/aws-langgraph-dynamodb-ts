import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

import { listSessions } from '../../../../src/history/actions/list-sessions';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
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
const sessionRow = (id: string, at: string, extra: Record<string, number> = {}) => ({
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

/**
 * A SESSION row a newer release wrote may have changed what its attributes
 * mean — `messageCount` renamed, `updatedAt` re-encoded — and returning it as an
 * ordinary session hands the caller wrong data with nothing to say so. Both
 * read paths refuse it, as the other reads that return this package's rows do.
 */
describe.each([
  ['the scan', false],
  ['the recency index', true],
])('listSessions through %s', (_path, indexed) => {
  it('refuses a SESSION row written in a newer format version', async () => {
    const { client, mock } = createStrictDocumentMock();
    serve(mock, [
      sessionRow('old', '2026-01-01T00:00:00Z'),
      sessionRow('new', '2026-01-02T00:00:00Z', { v: 2 }),
    ]);

    await expect(listSessions(context(client, indexed), { limit: 10 })).rejects.toMatchObject({
      code: ErrorCode.FORMAT_UNSUPPORTED,
      context: { field: 'v' },
    });
  });

  /** Checked before the ttl, so the answer does not depend on the reading machine's clock. */
  it('refuses a newer SESSION row even when it has expired', async () => {
    const { client, mock } = createStrictDocumentMock();
    serve(mock, [sessionRow('new', '2026-01-02T00:00:00Z', { v: 2, ttl: 1 })]);

    await expect(listSessions(context(client, indexed), { limit: 10 })).rejects.toMatchObject({
      code: ErrorCode.FORMAT_UNSUPPORTED,
      context: { field: 'v' },
    });
  });

  it('lists a row at the current version and a row written before the attribute', async () => {
    const { client, mock } = createStrictDocumentMock();
    serve(mock, [
      sessionRow('stamped', '2026-01-02T00:00:00Z', { v: 1 }),
      sessionRow('unstamped', '2026-01-01T00:00:00Z'),
    ]);

    const page = await listSessions(context(client, indexed), { limit: 10 });

    expect(page.sessions.map((session) => session.sessionId)).toEqual(['stamped', 'unstamped']);
  });

  /** A foreign row is not this package's to version: it is skipped, never refused. */
  it('still skips a foreign row that carries a high v', async () => {
    const { client, mock } = createStrictDocumentMock();
    serve(mock, [
      { PK: 'X', SK: 'OTHER', v: 9, gsi1sk: '2026-01-03T00:00:00Z#x' },
      sessionRow('real', '2026-01-01T00:00:00Z'),
    ]);

    const page = await listSessions(context(client, indexed), { limit: 10 });

    expect(page.sessions.map((session) => session.sessionId)).toEqual(['real']);
  });
});
