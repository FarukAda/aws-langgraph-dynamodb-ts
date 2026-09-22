import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { buildCheckpointItems } from '../../../src/checkpointer/internal/item-writer';
import type { CheckpointerContext } from '../../../src/checkpointer/internal/setup';
import { DynamoDBSaver } from '../../../src/checkpointer/saver';
import type { DocItem } from '../../../src/shared/dynamodb/types';
import { SILENT_LOGGER } from '../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../shared/helpers/ddb-mock';
import { FROZEN_NOW_MS } from '../../shared/helpers/test-setup';

const serde = {
  dumpsTyped: async (value: unknown): Promise<[string, Uint8Array]> =>
    await Promise.resolve(['json', new TextEncoder().encode(JSON.stringify(value))]),
  loadsTyped: async (_t: string, d: Uint8Array | string): Promise<unknown> =>
    await Promise.resolve(JSON.parse(typeof d === 'string' ? d : new TextDecoder().decode(d))),
};

const checkpoint: Checkpoint = {
  v: 4,
  id: 'live',
  ts: '2024-01-01T00:00:00.000Z',
  channel_values: { messages: ['hi'] },
  channel_versions: { messages: 1 },
  versions_seen: {},
};
const metadata: CheckpointMetadata = { source: 'loop', step: 2, parents: {} };

const NOW_SECONDS = Math.floor(FROZEN_NOW_MS / 1000);

/** The shape the query double reads off a Query input, without an SDK-wide cast. */
interface QueryInput {
  Limit?: number;
  ExclusiveStartKey?: { n: number };
  ExpressionAttributeValues?: Record<string, unknown>;
}

/**
 * A `Query` double that bills like DynamoDB: `Limit` bounds the rows
 * **evaluated** on a page, and the server-side ttl filter drops expired rows
 * from that page afterwards — so a page of nothing but expired rows comes back
 * empty with a `LastEvaluatedKey`, which is the shape that made the old
 * one-row page issue one request per expired row. `n` is the count of rows
 * already evaluated, the double's stand-in for a real key.
 */
function answerMetaQueries(
  mock: ReturnType<typeof createStrictDocumentMock>['mock'],
  rows: DocItem[],
): () => number {
  let metaQueries = 0;
  mock.on(QueryCommand).callsFake((raw: QueryInput) => {
    const prefix = String(raw.ExpressionAttributeValues?.[':skPrefix']);
    if (prefix.startsWith('WRITE#')) return { Items: [] };
    metaQueries += 1;
    const from = raw.ExclusiveStartKey === undefined ? 0 : raw.ExclusiveStartKey.n;
    const to = Math.min(from + (raw.Limit ?? rows.length), rows.length);
    const evaluated = rows.slice(from, to);
    const survivors = evaluated.filter(
      (row) => row.ttl === undefined || Number(row.ttl) > NOW_SECONDS,
    );
    if (to >= rows.length) return { Items: survivors };
    return { Items: survivors, LastEvaluatedKey: { n: to } };
  });
  return () => metaQueries;
}

/** A thread whose `expiredAhead` newest META rows have aged out under a `ttl`. */
async function seedThread(
  expiredAhead: number,
): Promise<{ saver: DynamoDBSaver; metaQueries: () => number }> {
  const { client, mock } = createStrictDocumentMock();
  const context: CheckpointerContext = { client, tableName: 'ckpt', serde, logger: SILENT_LOGGER };
  const { meta, payload } = await buildCheckpointItems(context, 't', '', checkpoint, metadata);
  const rows: DocItem[] = Array.from({ length: expiredAhead }, (_unused, index) => ({
    ...meta,
    SK: `META##dead-${index}`,
    checkpointId: `dead-${index}`,
    ttl: NOW_SECONDS - 1,
  }));
  rows.push(meta);
  const metaQueries = answerMetaQueries(mock, rows);
  mock.on(GetCommand).resolves({ Item: payload });
  return { saver: new DynamoDBSaver({ tableName: 'ckpt', client, serde }), metaQueries };
}

describe('the latest-checkpoint read pages past expired head rows (M-07)', () => {
  it('spends one Query on a thread whose 25 newest META rows have expired', async () => {
    const { saver, metaQueries } = await seedThread(25);
    const tuple = await saver.getTuple({ configurable: { thread_id: 't' } });
    expect(tuple?.checkpoint.id).toBe('live');
    expect(metaQueries()).toBe(1);
  });

  it('still spends one Query when nothing at the head has expired', async () => {
    const { saver, metaQueries } = await seedThread(0);
    const tuple = await saver.getTuple({ configurable: { thread_id: 't' } });
    expect(tuple?.checkpoint.id).toBe('live');
    expect(metaQueries()).toBe(1);
  });

  it('keeps paging when the expired run outruns one page, and still finds the live row', async () => {
    const { saver, metaQueries } = await seedThread(120);
    const tuple = await saver.getTuple({ configurable: { thread_id: 't' } });
    expect(tuple?.checkpoint.id).toBe('live');
    expect(metaQueries()).toBeGreaterThan(1);
    expect(metaQueries()).toBeLessThan(120);
  });
});
