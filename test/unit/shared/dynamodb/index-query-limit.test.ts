import { QueryCommand } from '@aws-sdk/lib-dynamodb';

import { MAX_LOOP_ITERATIONS, MAX_PAGE_LIMIT } from '../../../../src/shared/constants';
import { queryRecencyIndex } from '../../../../src/shared/dynamodb/index-query';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { parseLimit } from '../../../../src/shared/validation/primitives';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

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

/**
 * `queryRecencyIndex` takes its page size as a `PageLimit`, already checked
 * against the package-wide page rule — an integer from 0 to {@link
 * MAX_PAGE_LIMIT} — by the listing's own parser (`parseListSessionsRequest`),
 * not by this function itself. It used to demand at least 1 and carry no
 * ceiling at all, so `limit: 1e12` reached the merge loop.
 */
describe('queryRecencyIndex page limits', () => {
  it('accepts the ceiling itself', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    await expect(queryRecencyIndex(base(client, MAX_PAGE_LIMIT))).resolves.toEqual({ items: [] });
    expect(mock.commandCalls(QueryCommand).length).toBeGreaterThan(0);
  });

  /**
   * Answered before the merge rather than inside it. The `while` would not run
   * for a limit of 0, so an empty page with shards still unread would have gone
   * on to read `items[items.length - 1]` off an empty array to build a cursor,
   * and raised a bare `TypeError` where a caller asked for nothing.
   */
  it('answers a limit of 0 with an empty page and issues no query', async () => {
    const { client, mock } = createStrictDocumentMock();
    await expect(queryRecencyIndex(base(client, 0))).resolves.toEqual({ items: [] });
    expect(mock.commandCalls(QueryCommand)).toHaveLength(0);
  });
});

/**
 * `refillDryShards` loops while any shard is dry, and a shard that answers with
 * an empty page carrying a `LastEvaluatedKey` is dry forever. It carries no
 * iteration cap of its own because it does not need one: each pass advances the
 * shard's page count, and `readShardPage` stops the listing at
 * {@link MAX_LOOP_ITERATIONS} pages. What did once spin was a
 * `mapWithConcurrency` that started zero workers, so no pass advanced anything
 * and the loop turned with no I/O at all — the hang this test would have
 * reproduced as a timeout.
 */
describe('a shard that never reports its end', () => {
  it('ends the listing rather than spinning, and stops at the page cap', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: { gsi1sk: 'x' } });
    await expect(queryRecencyIndex(base(client, 5))).rejects.toMatchObject({
      code: ErrorCode.RESULT_TRUNCATED,
    });
    expect(mock.commandCalls(QueryCommand).length).toBeLessThanOrEqual(
      MAX_LOOP_ITERATIONS * base(client, 5).shards,
    );
  });
});
