import { ScanCommand, UpdateCommand, type UpdateCommandInput } from '@aws-sdk/lib-dynamodb';

import { backfillRecencyIndex } from '../../../../src/shared/dynamodb/backfill-index';
import type { DocItem } from '../../../../src/shared/dynamodb/types';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const TABLE = 'tbl';

/** A history SESSION row, which a listing reaches and the backfill therefore indexes. */
const session = {
  PK: 'HIST#s1',
  SK: 'HISTORY#SESSION',
  sessionId: 's1',
  updatedAt: '2026-02-02T00:00:00.000Z',
};

/** Where that row lives in the fake table. */
const SESSION_KEY = 'HIST#s1|HISTORY#SESSION';

function rowKey(item: { PK?: unknown; SK?: unknown }): string {
  return `${String(item.PK)}|${String(item.SK)}`;
}

/** The rejection DynamoDB answers a lost condition on an `UpdateItem` with. */
function rejection(): Error {
  return Object.assign(new Error('The conditional request failed'), {
    name: 'ConditionalCheckFailedException',
  });
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
  row: DocItem | undefined,
): boolean {
  const parsed = /^attribute_(not_)?exists\(([^)]+)\)$/.exec(clause.trim());
  if (parsed === null) throw new Error(`this fake does not evaluate '${clause}'`);
  const attribute = names[parsed[2]] ?? parsed[2];
  const present = row !== undefined && row[attribute] !== undefined;
  return parsed[1] === undefined ? present : !present;
}

/** Whether every `AND`-joined clause of the update's condition holds. */
function conditionHolds(input: UpdateCommandInput, row: DocItem | undefined): boolean {
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
function applyUpdate(input: UpdateCommandInput, row: DocItem | undefined): DocItem {
  const names = input.ExpressionAttributeNames ?? {};
  const values = input.ExpressionAttributeValues ?? {};
  const expression = input.UpdateExpression ?? '';
  if (!expression.startsWith('SET ')) throw new Error(`this fake does not apply '${expression}'`);
  const next: DocItem = { ...(row ?? (input.Key as DocItem)) };
  for (const assignment of expression.slice('SET '.length).split(', ')) {
    const [name, value] = assignment.split(' = ');
    next[names[name] ?? name] = values[value];
  }
  return next;
}

/** A table the backfill's conditional `UpdateItem` is evaluated and applied against. */
function updateTable(items: readonly DocItem[]): {
  rows: Map<string, DocItem>;
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
 * One pass whose scan answers `observed` while the table the writes land on
 * holds `current`. The difference between the two is the race under test.
 */
async function backfillAgainst(
  observed: readonly DocItem[],
  current: readonly DocItem[],
): Promise<{ rows: Map<string, DocItem>; outcome: 'resolved' | Error }> {
  const { client, mock } = createStrictDocumentMock();
  const table = updateTable(current);
  mock.on(ScanCommand).resolves({ Items: [...observed] });
  mock.on(UpdateCommand).callsFake(table.handler);
  const outcome = await backfillRecencyIndex({ client, tableName: TABLE }).then(
    (): 'resolved' => 'resolved',
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
    const { rows } = await backfillAgainst([session], []);
    expect(rows.has(SESSION_KEY)).toBe(false);
    expect(rows.size).toBe(0);
  });

  /**
   * That refusal is not swallowed: it reaches the caller through the tool's own
   * error boundary, as every rejection of this update already did. The run
   * stops rather than reporting the vanished row as work done — a backfill is
   * re-runnable, and the scan filter skips whatever the stopped run had already
   * indexed.
   */
  it('reports the refusal rather than counting the vanished row as indexed', async () => {
    const { outcome } = await backfillAgainst([session], []);
    expect(outcome).toMatchObject({ name: 'UpstreamError', code: ErrorCode.UPSTREAM });
    expect((outcome as Error).cause).toMatchObject({ name: 'ConditionalCheckFailedException' });
  });

  it('still gives an existing row that has no keys its index keys', async () => {
    const { rows, outcome } = await backfillAgainst([session], [session]);
    expect(outcome).toBe('resolved');
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
   * of every listing.
   */
  it('still refuses a row a live adapter has already indexed, leaving its keys alone', async () => {
    const indexed = { ...session, gsi1pk: 'SESS#3', gsi1sk: '2026-09-01T00:00:00.000Z#s1' };
    const { rows } = await backfillAgainst([session], [indexed]);
    expect(rows.get(SESSION_KEY)).toEqual(indexed);
  });
});
