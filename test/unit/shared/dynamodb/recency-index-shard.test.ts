import { QueryCommand } from '@aws-sdk/lib-dynamodb';

import { MAX_LOOP_ITERATIONS } from '../../../../src/shared/dynamodb/paginate';
import { readShardPage, shardReader } from '../../../../src/shared/dynamodb/recency-index';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { parseLimit } from '../../../../src/shared/validation/primitives';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { indexRows, simulatedIndex } from '../../../shared/helpers/simulated-index';

function options(client: ReturnType<typeof createStrictDocumentMock>['client']) {
  return {
    client,
    tableName: 'history',
    indexName: 'gsi1',
    tag: 'SESS' as const,
    shards: 1,
    concurrency: 1,
    limit: parseLimit(10, 0),
  };
}

describe('shardReader', () => {
  /** A fresh reader is dry and not exhausted, so a listing reads its first page before choosing. */
  it('starts before the first page with nothing buffered', () => {
    expect(shardReader('SESS#3')).toEqual({
      partition: 'SESS#3',
      buffer: [],
      startKey: undefined,
      exhausted: false,
      pages: 0,
    });
  });
});

describe('readShardPage', () => {
  /**
   * DynamoDB ends a page at 1 MB whatever `Limit` says, and hands back a
   * `LastEvaluatedKey`. The reader keeps the key, and its next page resumes
   * after it, asking only for the rows the caller says are still needed.
   */
  it('buffers one page, keeps its key and resumes after it', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(QueryCommand)
      .callsFake(simulatedIndex({ 'SESS#0': indexRows('SESS#0', [9, 8, 7, 6, 5, 4]) }, 3));
    const reader = shardReader('SESS#0');

    await readShardPage(options(client), reader, undefined, 10);
    expect(reader.buffer.map((row) => row.sessionId)).toEqual(['s7', 's8', 's9']);
    expect(reader.exhausted).toBe(false);
    expect(reader.pages).toBe(1);

    reader.buffer = [];
    await readShardPage(options(client), reader, undefined, 7);

    const inputs = mock.commandCalls(QueryCommand).map((call) => call.args[0].input);
    expect(inputs[0].ExclusiveStartKey).toBeUndefined();
    expect(inputs[0].Limit).toBe(10);
    expect(inputs[1].ExclusiveStartKey).toEqual({ gsi1sk: '2026-01-01T00:00:07.000Z#s7' });
    expect(inputs[1].Limit).toBe(7);
    expect(reader.buffer.map((row) => row.sessionId)).toEqual(['s4', 's5', 's6']);
    expect(reader.exhausted).toBe(true);
    expect(reader.pages).toBe(2);
  });

  it('reads below the cursor bound when one is given', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });

    await readShardPage(options(client), shardReader('SESS#0'), '2026#x', 4);

    const input = mock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.KeyConditionExpression).toBe('#pk = :pk AND #sk < :before');
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'SESS#0', ':before': '2026#x' });
  });

  /** A mocked or cached response is not reordered in place: the buffer is a copy. */
  it('leaves the response it read untouched', async () => {
    const { client, mock } = createStrictDocumentMock();
    const items = indexRows('SESS#0', [2, 1]);
    mock.on(QueryCommand).resolves({ Items: items });

    await readShardPage(options(client), shardReader('SESS#0'), undefined, 5);

    expect(items.map((row) => row.sessionId)).toEqual(['s2', 's1']);
  });

  /** DynamoDB omits `Items` for a page that matched nothing. */
  it('treats a page without Items as an empty, final page', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({});
    const reader = shardReader('SESS#0');

    await readShardPage(options(client), reader, undefined, 5);

    expect(reader).toMatchObject({ buffer: [], exhausted: true, pages: 1 });
  });

  /**
   * A partial shard would let a row from another shard, older than the
   * partial shard's unread rows, onto the page, and the cursor would then skip
   * those rows. A shard that has used its page budget is an error, not a short
   * answer, and no further query is issued for it.
   */
  it('refuses a page past MAX_LOOP_ITERATIONS without querying', async () => {
    const { client, mock } = createStrictDocumentMock();
    const reader = { ...shardReader('SESS#0'), pages: MAX_LOOP_ITERATIONS };

    await expect(readShardPage(options(client), reader, undefined, 5)).rejects.toMatchObject({
      code: ErrorCode.RESULT_TRUNCATED,
      context: { field: 'maxIterations' },
    });
    expect(mock.commandCalls(QueryCommand)).toHaveLength(0);
  });
});
