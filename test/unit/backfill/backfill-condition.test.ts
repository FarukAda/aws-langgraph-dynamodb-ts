import { ScanCommand, UpdateCommand, type UpdateCommandInput } from '@aws-sdk/lib-dynamodb';

import { backfillRecencyIndex } from '../../../src/backfill/backfill';
import type { BackfillResult } from '../../../src/backfill/backfill';
import type { AttributeMap } from '../../../src/shared/dynamodb/client';
import { ErrorCode } from '../../../src/shared/errors/error-code';
import { createStrictDocumentMock } from '../../shared/helpers/ddb-mock';

const TABLE = 'tbl';

/** A history SESSION row, which a listing reaches and the backfill therefore indexes. */
const session = {
  PK: 'HIST#s1',
  SK: 'HISTORY#SESSION',
  sessionId: 's1',
  updatedAt: '2026-02-02T00:00:00.000Z',
};

/** A second such row, on the page after it: the work a run that stopped never reaches. */
const other = {
  PK: 'HIST#s2',
  SK: 'HISTORY#SESSION',
  sessionId: 's2',
  updatedAt: '2026-03-03T00:00:00.000Z',
};

/** Where those rows live in the fake table. */
const SESSION_KEY = 'HIST#s1|HISTORY#SESSION';
const OTHER_KEY = 'HIST#s2|HISTORY#SESSION';

/** What a page that is not the last one reports as its last evaluated key. */
const PAGE_KEY = { PK: 'HIST#s1', SK: 'HISTORY#SESSION' };

function rowKey(item: { PK?: unknown; SK?: unknown }): string {
  return `${String(item.PK)}|${String(item.SK)}`;
}

/** An error DynamoDB answers a request with, under the name it carries. */
function failure(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

/** The rejection DynamoDB answers a lost condition on an `UpdateItem` with. */
function rejection(): Error {
  return failure('ConditionalCheckFailedException', 'The conditional request failed');
}

/**
 * Evaluate one `attribute_exists` / `attribute_not_exists` clause against the
 * row as it is *now*, resolving an `#alias` through the request's own names.
 *
 * The absent row is the case worth having a fake for. DynamoDB evaluates a
 * condition against a key that holds nothing as well, and there every attribute
 * is missing — so `attribute_not_exists` **holds** on an empty key, and the
 * update then creates the row. A clause this fake does not model raises rather
 * than being guessed at, so a condition it cannot read can never pass silently.
 */
function clauseHolds(
  clause: string,
  names: Record<string, string>,
  row: AttributeMap | undefined,
): boolean {
  const parsed = /^attribute_(not_)?exists\(([^)]+)\)$/.exec(clause.trim());
  if (parsed === null) throw new Error(`this fake does not evaluate '${clause}'`);
  const attribute = names[parsed[2]] ?? parsed[2];
  const present = row !== undefined && row[attribute] !== undefined;
  return parsed[1] === undefined ? present : !present;
}

/** Whether every `AND`-joined clause of the update's condition holds. */
function conditionHolds(input: UpdateCommandInput, row: AttributeMap | undefined): boolean {
  if (input.ConditionExpression === undefined) return true;
  const names = input.ExpressionAttributeNames ?? {};
  return input.ConditionExpression.split(' AND ').every((clause) =>
    clauseHolds(clause, names, row),
  );
}

/**
 * Apply a `SET a = :x, b = :y` to the row, **creating** it from the request's
 * `Key` when it is not there: `UpdateItem` upserts, and that is the behaviour
 * the condition exists to stop, so the fake has to have it.
 */
function applyUpdate(input: UpdateCommandInput, row: AttributeMap | undefined): AttributeMap {
  const names = input.ExpressionAttributeNames ?? {};
  const values = input.ExpressionAttributeValues ?? {};
  const expression = input.UpdateExpression ?? '';
  if (!expression.startsWith('SET ')) throw new Error(`this fake does not apply '${expression}'`);
  const next: AttributeMap = { ...(row ?? (input.Key as AttributeMap)) };
  for (const assignment of expression.slice('SET '.length).split(', ')) {
    const [name, value] = assignment.split(' = ');
    next[names[name] ?? name] = values[value];
  }
  return next;
}

/** A table the backfill's conditional `UpdateItem` is evaluated and applied against. */
function updateTable(items: readonly AttributeMap[]): {
  rows: Map<string, AttributeMap>;
  handler: (input: UpdateCommandInput) => object;
} {
  const rows = new Map(items.map((item) => [rowKey(item), item]));
  return {
    rows,
    handler: (input: UpdateCommandInput): object => {
      const key = rowKey(input.Key ?? {});
      const row = rows.get(key);
      if (!conditionHolds(input, row)) throw rejection();
      rows.set(key, applyUpdate(input, row));
      return {};
    },
  };
}

/**
 * One run whose scan answers `pages` in order while the table the writes land
 * on holds `current`. The difference between the two is the race under test,
 * and a second page is what shows whether a refusal on the first ended the
 * run: a run that ended there never issues the second scan, and a scan past
 * the last page raises rather than answering something the run could count.
 */
async function backfillAgainst(
  pages: readonly (readonly AttributeMap[])[],
  current: readonly AttributeMap[],
  run: { maxPages?: number } = {},
): Promise<{ rows: Map<string, AttributeMap>; outcome: BackfillResult | Error }> {
  const { client, mock } = createStrictDocumentMock();
  const table = updateTable(current);
  let page = 0;
  mock.on(ScanCommand).callsFake((): object => {
    const items = pages[page];
    if (items === undefined) throw new Error('the run scanned past its last page');
    page += 1;
    return { Items: [...items], LastEvaluatedKey: page < pages.length ? PAGE_KEY : undefined };
  });
  mock.on(UpdateCommand).callsFake(table.handler);
  const outcome = await backfillRecencyIndex({ client, tableName: TABLE, ...run }).then(
    (result): BackfillResult => result,
    (error: Error) => error,
  );
  return { rows: table.rows, outcome };
}

describe('backfillRecencyIndex writes only to a row that is still there', () => {
  /**
   * The race the condition has to close: the scan sees a row, something deletes
   * it, and the update lands on a key that now holds nothing. An `UpdateItem`
   * creates the row it is given, so a condition naming only the index attribute
   * is satisfied by that empty key — and the row comes back as a stub carrying
   * nothing but `PK`, `SK` and the two index keys. Because it carries them, it
   * comes back *inside* the recency index, which is what a thread-less
   * `saver.list()` and `history.listSessions()` read.
   *
   * Asserting the absence of the row rather than the text of the condition is
   * the whole point: a condition that does nothing builds the same request.
   */
  it('does not re-create a row deleted between the scan and the update', async () => {
    const { rows } = await backfillAgainst([[session]], []);
    expect(rows.has(SESSION_KEY)).toBe(false);
    expect(rows.size).toBe(0);
  });

  /**
   * The refusal is this run's own condition doing its job, not a failure: the
   * row is gone, so there is nothing left to give keys to. It is counted as
   * skipped and the walk goes on — the second page, which a run that ended at
   * the refusal never scans, is what tells the two apart.
   */
  it('counts a row that vanished between the scan and the update as skipped, and reads on', async () => {
    const { rows, outcome } = await backfillAgainst([[session], [other]], [other]);
    expect(outcome).toEqual({ scanned: 2, indexed: 1, skipped: 1 });
    expect(rows.has(SESSION_KEY)).toBe(false);
    expect(rows.get(OTHER_KEY)).toMatchObject({ gsi1sk: '2026-03-03T00:00:00.000Z#s2' });
  });

  it('still gives an existing row that has no keys its index keys', async () => {
    const { rows, outcome } = await backfillAgainst([[session]], [session]);
    expect(outcome).toEqual({ scanned: 1, indexed: 1, skipped: 0 });
    expect(rows.get(SESSION_KEY)).toEqual({
      ...session,
      gsi1pk: expect.stringMatching(/^SESS#\d+$/),
      gsi1sk: '2026-02-02T00:00:00.000Z#s1',
    });
  });

  /**
   * The other half of the same condition, unchanged: a row a live adapter
   * indexed between the scan and the update carries its true timestamp, and
   * overwriting it with the pre-index epoch would move a live row to the bottom
   * of every listing. On a table with a running graph that refusal is the
   * ordinary case rather than an edge one, so it too is skipped and read past.
   */
  it('still refuses a row a live adapter has already indexed, leaving its keys alone', async () => {
    const indexed = { ...session, gsi1pk: 'SESS#3', gsi1sk: '2026-09-01T00:00:00.000Z#s1' };
    const { rows, outcome } = await backfillAgainst([[session], [other]], [indexed, other]);
    expect(rows.get(SESSION_KEY)).toEqual(indexed);
    expect(outcome).toEqual({ scanned: 2, indexed: 1, skipped: 1 });
  });

  /**
   * What keeps the catch from being a swallow. Only the guard's own refusal is
   * an ordinary outcome; anything else still reaches the caller through the
   * tool's error boundary. Without this, a backfill that cannot write at all —
   * a malformed request, a denied permission — would report a tableful of
   * skipped rows and finish as if the table had been walked.
   */
  it('still ends the run when the update fails for any other reason', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [session] });
    mock.on(UpdateCommand).callsFake((): object => {
      throw failure('ValidationException', 'ExpressionAttributeValues contains invalid value');
    });
    const outcome = await backfillRecencyIndex({ client, tableName: TABLE }).catch(
      (error: Error) => error,
    );
    expect(outcome).toMatchObject({ name: 'DynamoDBLangGraphError', code: ErrorCode.AWS_REJECTED });
    expect((outcome as Error).cause).toMatchObject({ name: 'ValidationException' });
  });

  /**
   * A refusal does not hold the cursor back. The run stops at its page cap,
   * not at the refused row, and the cursor it returns is the one the scan
   * reported — so resuming carries on past that page rather than re-reading
   * it, which is right in both directions: the refused row needs nothing done
   * to it, and the scan's own filter skips whatever the page did index.
   */
  it('advances the cursor of a capped run whose only row was refused', async () => {
    const { outcome } = await backfillAgainst([[session], [other]], [other], { maxPages: 1 });
    expect(outcome).toMatchObject({ scanned: 1, indexed: 0, skipped: 1 });
    expect((outcome as BackfillResult).nextCursor).toEqual(expect.any(String));
  });
});
