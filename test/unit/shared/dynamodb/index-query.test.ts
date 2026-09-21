import { QueryCommand } from '@aws-sdk/lib-dynamodb';

import { metaRows } from '../../../../src/checkpointer/internal/list-rows';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { DynamoDBSaver } from '../../../../src/checkpointer/saver';
import { listSessions } from '../../../../src/history/actions/list-sessions';
import { DynamoDBChatMessageHistory } from '../../../../src/history/chat-message-history';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { DEFAULT_READ_CONCURRENCY } from '../../../../src/shared/constants';
import {
  iterateRecencyIndex,
  queryRecencyIndex,
} from '../../../../src/shared/dynamodb/index-query';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { indexRow, indexRows, simulatedIndex } from '../../../shared/helpers/simulated-index';

type StrictMock = ReturnType<typeof createStrictDocumentMock>;

function row(at: string, id: string) {
  return {
    PK: `SESS#${id}`,
    SK: 'SESSION',
    sessionId: id,
    gsi1pk: 'SESS#0',
    gsi1sk: `${at}#${id}`,
  };
}

function base(client: StrictMock['client'], limit: number) {
  return {
    client,
    tableName: 'history',
    indexName: 'gsi1',
    tag: 'SESS' as const,
    shards: 2,
    concurrency: 2,
    limit,
  };
}

const ids = (items: { sessionId?: unknown }[]) => items.map((item) => item.sessionId);

describe('queryRecencyIndex', () => {
  /**
   * Each shard is already sorted, so merging their pages and taking `limit`
   * is correct: no shard can contribute a row newer than the ones it returned.
   */
  it('merges every shard newest-first', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(QueryCommand)
      .callsFake((input) =>
        input.ExpressionAttributeValues[':pk'] === 'SESS#0'
          ? { Items: [row('2026-01-03T00:00:00Z', 'c'), row('2026-01-01T00:00:00Z', 'a')] }
          : { Items: [row('2026-01-02T00:00:00Z', 'b')] },
      );
    const page = await queryRecencyIndex(base(client, 3));
    expect(page.items.map((item) => item.sessionId)).toEqual(['c', 'b', 'a']);
  });

  it('queries every shard of the adapter', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    await queryRecencyIndex(base(client, 5));
    const partitions = mock
      .commandCalls(QueryCommand)
      .map((call) => call.args[0].input.ExpressionAttributeValues?.[':pk']);
    expect(partitions.sort()).toEqual(['SESS#0', 'SESS#1']);
  });

  /**
   * The cursor says whether rows remain, not whether the page filled up. A
   * shard that reported a `LastEvaluatedKey` may hold more; two shards that
   * reported none and between them filled the page exactly hold nothing more,
   * and a cursor there would cost an empty round of queries.
   */
  it('hands back a cursor only while rows remain', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({
      Items: [row('2026-01-01T00:00:00Z', 'a')],
      LastEvaluatedKey: { gsi1sk: '2026-01-01T00:00:00Z#a' },
    });
    expect((await queryRecencyIndex(base(client, 1))).nextCursor).toBeDefined();

    mock.reset();
    mock.on(QueryCommand).resolves({ Items: [row('2026-01-01T00:00:00Z', 'a')] });
    expect((await queryRecencyIndex(base(client, 2))).nextCursor).toBeUndefined();
  });

  it('resumes below the cursor it issued', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({
      Items: [row('2026-01-05T00:00:00Z', 'e')],
      LastEvaluatedKey: { gsi1sk: '2026-01-05T00:00:00Z#e' },
    });
    const first = await queryRecencyIndex(base(client, 1));
    expect(first.nextCursor).toBeDefined();
    await queryRecencyIndex({ ...base(client, 1), cursor: first.nextCursor });
    const second = mock.commandCalls(QueryCommand).at(-1)?.args[0].input;
    expect(second?.KeyConditionExpression).toBe('#pk = :pk AND #sk < :before');
    expect(second?.ExpressionAttributeValues?.[':before']).toBe('2026-01-05T00:00:00Z#e');
  });

  it('reads the index newest-first, never the table', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    await queryRecencyIndex(base(client, 1));
    const input = mock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.IndexName).toBe('gsi1');
    expect(input.ScanIndexForward).toBe(false);
  });

  it.each([-1, 1.5])('refuses a limit of %p', async (limit) => {
    const { client } = createStrictDocumentMock();
    await expect(queryRecencyIndex(base(client, limit))).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
    });
  });

  /** DynamoDB omits `Items` for a shard that holds nothing, rather than sending an empty list. */
  it('treats a shard that returns no Items as an empty shard', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(QueryCommand)
      .callsFake((input) =>
        input.ExpressionAttributeValues[':pk'] === 'SESS#0'
          ? { Items: [row('2026-01-01T00:00:00Z', 'a')] }
          : {},
      );

    const page = await queryRecencyIndex(base(client, 10));

    expect(page.items.map((item) => item.sessionId)).toEqual(['a']);
  });

  /**
   * A `gsi1sk` is `<timestamp>#<id>`. A value carrying no `#` came from
   * somewhere else — a scan cursor, a token from another API — and using it as
   * a bound would quietly return the wrong page instead of saying so.
   */
  it.each([
    ['a scan cursor', Buffer.from('{"PK":"x"}', 'utf8').toString('base64url')],
    ['plain text', Buffer.from('nonsense', 'utf8').toString('base64url')],
    ['empty', ''],
  ])('refuses %s as a cursor', async (_name, cursor) => {
    const { client } = createStrictDocumentMock();
    await expect(queryRecencyIndex({ ...base(client, 10), cursor })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'cursor' },
    });
  });

  it('refuses a cursor it did not issue', async () => {
    const { client } = createStrictDocumentMock();
    await expect(queryRecencyIndex({ ...base(client, 2), cursor: '' })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
    });
  });
});

/**
 * DynamoDB ends a `Query` page at 1 MB of evaluated data whatever `Limit` says,
 * and reports the rest with a `LastEvaluatedKey` (C-01). The simulated index
 * cuts every page at a few rows to stand in for that boundary.
 */
describe('a recency listing across the 1 MB page boundary (C-01)', () => {
  const sixInOneShard = { 'SESS#0': indexRows('SESS#0', [6, 5, 4, 3, 2, 1]), 'SESS#1': [] };

  it('lists every row of a shard whose rows span several pages, and issues no cursor', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).callsFake(simulatedIndex(sixInOneShard, 3));

    const page = await queryRecencyIndex(base(client, 10));

    expect(ids(page.items)).toEqual(['s6', 's5', 's4', 's3', 's2', 's1']);
    expect(page.nextCursor).toBeUndefined();
  });

  it('streams every row of that shard', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).callsFake(simulatedIndex(sixInOneShard, 3));
    const { limit: _limit, ...options } = base(client, 1);

    const rows = [];
    for await (const item of iterateRecencyIndex(options)) rows.push(item);

    expect(ids(rows)).toEqual(['s6', 's5', 's4', 's3', 's2', 's1']);
  });

  it('hands back a cursor when a cut page leaves rows behind', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).callsFake(simulatedIndex(sixInOneShard, 2));

    const page = await queryRecencyIndex(base(client, 3));

    expect(ids(page.items)).toEqual(['s6', 's5', 's4']);
    expect(page.nextCursor).toBeDefined();
  });

  /**
   * Shard 1's newest row is older than shard 0's third. A merge that took
   * shard 0's cut page of two rows as the whole shard would put shard 1's
   * newest row third on the page, and its cursor would skip s15 and s13.
   */
  it('pages two uneven shards to the end without skipping or repeating a row', async () => {
    const { client, mock } = createStrictDocumentMock();
    const shard0 = [20, 18, 15, 13, 8, 6, 2];
    const shard1 = [12, 10, 4, 3];
    mock
      .on(QueryCommand)
      .callsFake(
        simulatedIndex(
          { 'SESS#0': indexRows('SESS#0', shard0), 'SESS#1': indexRows('SESS#1', shard1) },
          2,
        ),
      );

    const seen: unknown[] = [];
    let cursor: string | undefined;
    for (let round = 0; round < 20; round++) {
      const page = await queryRecencyIndex({ ...base(client, 3), cursor });
      seen.push(...ids(page.items));
      cursor = page.nextCursor;
      if (cursor === undefined) break;
    }

    const every = [...shard0, ...shard1].sort((a, b) => b - a).map((second) => `s${second}`);
    expect(cursor).toBeUndefined();
    expect(seen).toEqual(every);
  });

  it('issues no cursor when exhausted shards fill the page exactly', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(QueryCommand)
      .callsFake(
        simulatedIndex(
          { 'SESS#0': [indexRow('SESS#0', 2)], 'SESS#1': [indexRow('SESS#1', 1)] },
          10,
        ),
      );

    const page = await queryRecencyIndex(base(client, 2));

    expect(ids(page.items)).toEqual(['s2', 's1']);
    expect(page.nextCursor).toBeUndefined();
    expect(mock.commandCalls(QueryCommand)).toHaveLength(2);
  });

  it('stops between follow-up pages when the signal fires', async () => {
    const { client, mock } = createStrictDocumentMock();
    const controller = new AbortController();
    mock.on(QueryCommand).callsFake(() => {
      controller.abort();
      return { Items: [indexRow('SESS#0', 5)], LastEvaluatedKey: { gsi1sk: 'x#y' } };
    });

    await expect(
      queryRecencyIndex({ ...base(client, 3), shards: 1, signal: controller.signal }),
    ).rejects.toMatchObject({ code: ErrorCode.ABORTED });
    expect(mock.commandCalls(QueryCommand)).toHaveLength(1);
  });
});

/**
 * Count the queries in flight at once: each answers an empty shard only after
 * yielding to the event loop, so every query started together overlaps.
 */
function peakInFlight(mock: StrictMock['mock']): () => number {
  let inFlight = 0;
  let peak = 0;
  mock.on(QueryCommand).callsFake(async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight -= 1;
    return { Items: [] };
  });
  return () => peak;
}

function partitionsQueried(mock: StrictMock['mock']): string[] {
  return mock
    .commandCalls(QueryCommand)
    .map((call) => call.args[0].input.ExpressionAttributeValues?.[':pk'] as string)
    .sort();
}

/**
 * One listing queried every shard at once, up to the 1024 `indexShards`
 * allows (H-08). The fan-out is `readConcurrency`, measured rather than assumed.
 */
describe('a recency listing bounds its fan-out (H-08)', () => {
  it('queries at most `concurrency` shards at once, and every shard', async () => {
    const { client, mock } = createStrictDocumentMock();
    const peak = peakInFlight(mock);

    await queryRecencyIndex({ ...base(client, 5), shards: 8, concurrency: 2 });

    expect(peak()).toBe(2);
    expect(partitionsQueried(mock)).toEqual(
      Array.from({ length: 8 }, (_, shard) => `SESS#${shard}`).sort(),
    );
  });

  it('bounds history.listSessions by readConcurrency', async () => {
    const { client, mock } = createStrictDocumentMock();
    const peak = peakInFlight(mock);
    const history = new DynamoDBChatMessageHistory({
      tableName: 'history',
      client,
      indexName: 'gsi1',
      indexShards: 4,
      readConcurrency: 1,
    });

    await expect(history.listSessions()).resolves.toEqual({ sessions: [] });

    expect(peak()).toBe(1);
    expect(partitionsQueried(mock)).toHaveLength(4);
  });

  it('bounds a thread-less saver.list by readConcurrency', async () => {
    const { client, mock } = createStrictDocumentMock();
    const peak = peakInFlight(mock);
    const saver = new DynamoDBSaver({
      tableName: 'ckpt',
      client,
      indexName: 'gsi1',
      indexShards: 4,
      readConcurrency: 1,
    });

    const tuples = [];
    for await (const tuple of saver.list({ configurable: {} })) tuples.push(tuple);

    expect(tuples).toEqual([]);
    expect(peak()).toBe(1);
    expect(partitionsQueried(mock)).toHaveLength(4);
  });

  /** A context that names no `readConcurrency` is bounded by the default, not by its shard count. */
  it('bounds listSessions by DEFAULT_READ_CONCURRENCY when the context names none', async () => {
    const { client, mock } = createStrictDocumentMock();
    const peak = peakInFlight(mock);

    await listSessions({
      client,
      tableName: 'history',
      serde: JSON_SERDE,
      logger: SILENT_LOGGER,
      ulid: () => 'U',
      onCorruptMessage: 'skip',
      indexName: 'gsi1',
      indexShards: 16,
    });

    expect(peak()).toBe(DEFAULT_READ_CONCURRENCY);
    expect(partitionsQueried(mock)).toHaveLength(16);
  });

  it('bounds the thread-less checkpoint rows by DEFAULT_READ_CONCURRENCY likewise', async () => {
    const { client, mock } = createStrictDocumentMock();
    const peak = peakInFlight(mock);
    const context = {
      client,
      tableName: 'ckpt',
      serde: JSON_SERDE,
      logger: SILENT_LOGGER,
      indexName: 'gsi1',
      indexShards: 16,
    } as CheckpointerContext;
    const scope = {
      threadId: undefined,
      checkpointNs: undefined,
      checkpointId: undefined,
      before: undefined,
      filter: undefined,
      limit: undefined,
      signal: undefined,
    };

    const rows = [];
    for await (const item of metaRows(context, scope, 1_000)) rows.push(item);

    expect(rows).toEqual([]);
    expect(peak()).toBe(DEFAULT_READ_CONCURRENCY);
    expect(partitionsQueried(mock)).toHaveLength(16);
  });
});
