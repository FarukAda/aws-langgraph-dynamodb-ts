import { QueryCommand, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';

import { MAX_LOOP_ITERATIONS } from '../../../../src/shared/constants';
import type { DocItem } from '../../../../src/shared/dynamodb/client';
import { queryRecencyIndex } from '../../../../src/shared/dynamodb/recency-index';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { parseLimit } from '../../../../src/shared/validation/primitives';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { indexRow, indexRows, simulatedIndex } from '../../../shared/helpers/simulated-index';

type StrictMock = ReturnType<typeof createStrictDocumentMock>;

function base(client: StrictMock['client'], limit: number) {
  return {
    client,
    tableName: 'history',
    indexName: 'gsi1',
    tag: 'SESS' as const,
    shards: 2,
    concurrency: 2,
    limit: parseLimit(limit, 0),
  };
}

const ids = (items: DocItem[]) => items.map((item) => item.sessionId as string);

/** One logged `Query`: the shard it read, the `Limit` it asked for and the rows it got. */
interface LoggedQuery {
  partition: string;
  limit: number;
  returned: string[];
}

/** Answer every query with `answer` and log it in the order it was issued. */
function loggedIndex(mock: StrictMock['mock'], answer: ReturnType<typeof simulatedIndex>) {
  const log: LoggedQuery[] = [];
  mock.on(QueryCommand).callsFake((input: QueryCommandInput) => {
    const result = answer(input);
    log.push({
      partition: input.ExpressionAttributeValues?.[':pk'] as string,
      limit: input.Limit as number,
      returned: ids(result.Items),
    });
    return result;
  });
  return log;
}

/**
 * A page holds `limit` rows, and each shard's rows come off its last DynamoDB
 * page one at a time, newest first. A shard reads its next page only when the
 * listing needs its next row, so a listing holds about one page per shard
 * rather than `limit` rows of every shard.
 */
describe('queryRecencyIndex reads each shard one page at a time', () => {
  /**
   * Shard 1's six rows are all newer than shard 0's, so the page of five comes
   * from shard 1 alone. Shard 0's first page is read, because until it is read
   * nothing says its rows are older, but it is never followed.
   */
  it('does not follow a shard whose rows the page does not need', async () => {
    const { client, mock } = createStrictDocumentMock();
    const log = loggedIndex(
      mock,
      simulatedIndex(
        {
          'SESS#0': indexRows('SESS#0', [6, 5, 4, 3, 2, 1]),
          'SESS#1': indexRows('SESS#1', [20, 19, 18, 17, 16, 15]),
        },
        { 'SESS#0': 2, 'SESS#1': 10 },
      ),
    );

    const page = await queryRecencyIndex(base(client, 5));

    expect(ids(page.items)).toEqual(['s20', 's19', 's18', 's17', 's16']);
    expect(page.nextCursor).toBeDefined();
    expect(log.filter((entry) => entry.partition === 'SESS#0')).toHaveLength(1);
  });

  /**
   * DynamoDB can answer a page with no rows and a `LastEvaluatedKey`. That
   * shard may still hold the newest row of all, so no row is chosen until it
   * has been read again.
   */
  it('reads a shard that answered no rows and a key again before choosing a row', async () => {
    const { client, mock } = createStrictDocumentMock();
    let shard0Pages = 0;
    mock.on(QueryCommand).callsFake((input: QueryCommandInput) => {
      if (input.ExpressionAttributeValues?.[':pk'] === 'SESS#1') {
        return { Items: indexRows('SESS#1', [5, 4]) };
      }
      shard0Pages += 1;
      return shard0Pages === 1
        ? { Items: [], LastEvaluatedKey: { gsi1sk: '2026-01-01T00:00:59.000Z#s59' } }
        : { Items: [indexRow('SESS#0', 9)] };
    });

    const page = await queryRecencyIndex(base(client, 2));

    expect(ids(page.items)).toEqual(['s9', 's5']);
    expect(shard0Pages).toBe(2);
  });

  /**
   * The `Limit` of a follow-up page is the rows the page still needs, so it
   * says how many rows were already on the page when that query was issued.
   * Every row the shard's previous page returned must be among them: a shard
   * is read again only once its buffer is empty.
   */
  it('reads a shard again only after every row of its last page is on the page', async () => {
    const { client, mock } = createStrictDocumentMock();
    const log = loggedIndex(
      mock,
      simulatedIndex(
        {
          'SESS#0': indexRows('SESS#0', [20, 18, 15, 13, 8, 6, 2]),
          'SESS#1': indexRows('SESS#1', [19, 12, 10, 4, 3]),
        },
        2,
      ),
    );

    const page = await queryRecencyIndex(base(client, 8));

    expect(ids(page.items)).toEqual(['s20', 's19', 's18', 's15', 's13', 's12', 's10', 's8']);
    log.forEach((entry, index) => {
      const previous = log
        .slice(0, index)
        .filter((earlier) => earlier.partition === entry.partition)
        .at(-1);
      if (previous === undefined) return;
      const placed = ids(page.items).slice(0, 8 - entry.limit);
      expect(placed).toEqual(expect.arrayContaining(previous.returned));
    });
    const limits = (partition: string) =>
      log.filter((entry) => entry.partition === partition).map((entry) => entry.limit);
    expect(limits('SESS#0')).toEqual([8, 5, 3]);
    expect(limits('SESS#1')).toEqual([8, 2]);
  });

  /**
   * DynamoDB ends a page at 1 MB whatever `Limit` says. The next page resumes
   * after the key the cut page carried, and asks only for the rows the page
   * still needs.
   */
  it('resumes a cut shard after its key, asking only for the rows still missing', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(QueryCommand)
      .callsFake(simulatedIndex({ 'SESS#0': indexRows('SESS#0', [9, 8, 7, 6, 5, 4]) }, 3));

    const page = await queryRecencyIndex({ ...base(client, 10), shards: 1 });

    const inputs = mock.commandCalls(QueryCommand).map((call) => call.args[0].input);
    expect(inputs).toHaveLength(2);
    expect(inputs[0].ExclusiveStartKey).toBeUndefined();
    expect(inputs[1].ExclusiveStartKey).toEqual({ gsi1sk: page.items[2].gsi1sk });
    expect(inputs[1].Limit).toBe(7);
    expect(page.items).toHaveLength(6);
    expect(page.nextCursor).toBeUndefined();
  });

  /** A shard whose pages never end fails the listing rather than hand back part of itself. */
  it('raises RESULT_TRUNCATED after MAX_LOOP_ITERATIONS pages that never end', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: { gsi1sk: 'x#y' } });

    await expect(queryRecencyIndex({ ...base(client, 5), shards: 1 })).rejects.toMatchObject({
      code: ErrorCode.RESULT_TRUNCATED,
      context: { field: 'maxIterations' },
    });
    expect(mock.commandCalls(QueryCommand)).toHaveLength(MAX_LOOP_ITERATIONS);
  });
});
