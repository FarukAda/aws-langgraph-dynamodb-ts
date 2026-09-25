import { QueryCommand } from '@aws-sdk/lib-dynamodb';

import type { AttributeMap } from '../../../../src/shared/dynamodb/client';
import { queryRecencyIndex } from '../../../../src/shared/dynamodb/recency-index';
import { compareSortKeys } from '../../../../src/shared/dynamodb/table-schema';
import { parseLimit } from '../../../../src/shared/validation/primitives';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { indexRow, simulatedIndex } from '../../../shared/helpers/simulated-index';

/** U+1F600 GRINNING FACE: one astral code point, two UTF-16 code units. */
const ASTRAL = '\u{1F600}';
/** U+FF01 FULLWIDTH EXCLAMATION MARK: one high-BMP code unit, below a surrogate. */
const HIGH_BMP = '！';

type StrictMock = ReturnType<typeof createStrictDocumentMock>;

const ids = (items: AttributeMap[]) => items.map((item) => item.sessionId as string);

/**
 * Read the whole index `limit` rows at a time, following the cursor, so the
 * listing has to cross a page boundary between the tied rows.
 */
async function drain(client: StrictMock['client'], limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await queryRecencyIndex({
      client,
      tableName: 'history',
      indexName: 'gsi1',
      tag: 'SESS',
      shards: 2,
      concurrency: 2,
      limit: parseLimit(limit, 0),
      ...(cursor === undefined ? {} : { cursor }),
    });
    seen.push(...ids(result.items));
    cursor = result.nextCursor;
    if (cursor === undefined) break;
  }
  return seen;
}

/** Two shards tied on the timestamp, split by ids the two orders disagree on. */
function tiedShards(mock: StrictMock['mock']): void {
  mock.on(QueryCommand).callsFake(
    simulatedIndex(
      {
        'SESS#0': [indexRow('SESS#0', 5, HIGH_BMP)],
        'SESS#1': [indexRow('SESS#1', 5, ASTRAL), indexRow('SESS#1', 4, 'older')],
      },
      10,
    ),
  );
}

/**
 * The merge picks the newest buffered row in memory and the cursor is the last
 * key it handed out, while the bound that resumes the listing is a DynamoDB
 * key condition. Where the two orders disagree the resumed query either skips
 * a row the page never took, or returns one it already handed out.
 */
describe('queryRecencyIndex merges shards in the order DynamoDB sorts them', () => {
  it('skips no row when the page boundary falls between two tied shards', async () => {
    const { client, mock } = createStrictDocumentMock();
    tiedShards(mock);

    expect(await drain(client, 1)).toEqual([ASTRAL, HIGH_BMP, 'older']);
  });

  it('hands out no row twice when both tied rows fit on one page', async () => {
    const { client, mock } = createStrictDocumentMock();
    tiedShards(mock);

    const seen = await drain(client, 2);
    expect(seen).toEqual([ASTRAL, HIGH_BMP, 'older']);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe('compareSortKeys', () => {
  it('orders by UTF-8 bytes where JavaScript orders by UTF-16 code units', () => {
    expect(`A${ASTRAL}` > `A${HIGH_BMP}`).toBe(false);
    expect(compareSortKeys(`A${ASTRAL}`, `A${HIGH_BMP}`)).toBe(1);
    expect(compareSortKeys(`A${HIGH_BMP}`, `A${ASTRAL}`)).toBe(-1);
  });

  it('calls a key equal to itself', () => {
    expect(compareSortKeys(`x#${ASTRAL}`, `x#${ASTRAL}`)).toBe(0);
  });
});
