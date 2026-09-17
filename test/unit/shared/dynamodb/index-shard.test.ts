import { QueryCommand } from '@aws-sdk/lib-dynamodb';

import { MAX_LOOP_ITERATIONS } from '../../../../src/shared/constants';
import { queryShard } from '../../../../src/shared/dynamodb/index-shard';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { indexRows, simulatedIndex } from '../../../shared/helpers/simulated-index';

function options(client: ReturnType<typeof createStrictDocumentMock>['client'], limit: number) {
  return {
    client,
    tableName: 'history',
    indexName: 'gsi1',
    tag: 'SESS' as const,
    shards: 1,
    concurrency: 1,
    limit,
  };
}

describe('queryShard', () => {
  /**
   * DynamoDB ends a page at 1 MB whatever `Limit` says, and hands back a
   * `LastEvaluatedKey`. The next page must resume after that key, and ask only
   * for the rows the first page did not supply.
   */
  it('asks a follow-up page only for the rows still missing', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(QueryCommand)
      .callsFake(simulatedIndex({ 'SESS#0': indexRows('SESS#0', [9, 8, 7, 6, 5, 4]) }, 3));

    const shard = await queryShard(options(client, 10), 'SESS#0', undefined);

    const inputs = mock.commandCalls(QueryCommand).map((call) => call.args[0].input);
    expect(inputs).toHaveLength(2);
    expect(inputs[0].ExclusiveStartKey).toBeUndefined();
    expect(inputs[1].ExclusiveStartKey).toEqual({ gsi1sk: shard.items[2].gsi1sk });
    expect(inputs[1].Limit).toBe(7);
    expect(shard.items).toHaveLength(6);
    expect(shard.exhausted).toBe(true);
  });

  /** A shard that has supplied `limit` rows stops there, and says rows may remain. */
  it('stops once it holds limit rows and reports the shard as not exhausted', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(QueryCommand)
      .callsFake(simulatedIndex({ 'SESS#0': indexRows('SESS#0', [9, 8, 7, 6, 5, 4]) }, 2));

    const shard = await queryShard(options(client, 3), 'SESS#0', undefined);

    expect(shard.items.map((row) => row.sessionId)).toEqual(['s9', 's8', 's7']);
    expect(shard.exhausted).toBe(false);
    expect(mock.commandCalls(QueryCommand)).toHaveLength(2);
  });

  /**
   * A partial shard would let a row from another shard, older than the
   * partial shard's unread rows, onto the page, and the cursor would then skip
   * those rows. A shard that never ends is therefore an error, not a short
   * answer.
   */
  it('raises RESULT_TRUNCATED after MAX_LOOP_ITERATIONS pages that never end', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: { gsi1sk: 'x#y' } });

    await expect(queryShard(options(client, 5), 'SESS#0', undefined)).rejects.toMatchObject({
      code: ErrorCode.RESULT_TRUNCATED,
      context: { field: 'maxIterations' },
    });
    expect(mock.commandCalls(QueryCommand)).toHaveLength(MAX_LOOP_ITERATIONS);
  });

  /** DynamoDB omits `Items` for a page that matched nothing. */
  it('treats a page without Items as an empty page', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({});

    await expect(queryShard(options(client, 5), 'SESS#0', undefined)).resolves.toEqual({
      items: [],
      exhausted: true,
    });
  });
});
