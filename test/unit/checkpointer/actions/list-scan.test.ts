import { GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
} from '@langchain/langgraph-checkpoint';

import { listCheckpoints } from '../../../../src/checkpointer/actions/list';
import { buildCheckpointItems } from '../../../../src/checkpointer/internal/item-writer';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import type { CheckpointMetaItem, CheckpointPayloadItem } from '../../../../src/checkpointer/types';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { FROZEN_NOW_MS } from '../../../shared/helpers/test-setup';

const serde = {
  dumpsTyped: async (value: unknown): Promise<[string, Uint8Array]> => [
    'json',
    new TextEncoder().encode(JSON.stringify(value)),
  ],
  loadsTyped: async (_t: string, d: Uint8Array | string): Promise<unknown> =>
    JSON.parse(typeof d === 'string' ? d : new TextDecoder().decode(d)),
};

function context(client: CheckpointerContext['client']): CheckpointerContext {
  return { client, tableName: 'ckpt', serde, logger: SILENT_LOGGER };
}

function checkpoint(id: string): Checkpoint {
  return { v: 4, id, ts: '', channel_values: {}, channel_versions: {}, versions_seen: {} };
}

async function collect(gen: AsyncGenerator<CheckpointTuple>): Promise<CheckpointTuple[]> {
  const out: CheckpointTuple[] = [];
  for await (const tuple of gen) out.push(tuple);
  return out;
}

interface Row {
  meta: CheckpointMetaItem;
  payload: CheckpointPayloadItem;
}

/** Checkpoints across two threads and two namespaces, with distinct metadata sources. */
async function fixtures(ctx: CheckpointerContext): Promise<Row[]> {
  const meta = (source: CheckpointMetadata['source'], step: number): CheckpointMetadata => ({
    source,
    step,
    parents: {},
  });
  return Promise.all([
    buildCheckpointItems(ctx, 't1', '', checkpoint('c1'), meta('input', -1), 'n'),
    buildCheckpointItems(ctx, 't1', '', checkpoint('c2'), meta('loop', 0), 'n', 'c1'),
    buildCheckpointItems(ctx, 't1', 'child', checkpoint('c3'), meta('loop', 1), 'n'),
    buildCheckpointItems(ctx, 't2', '', checkpoint('c4'), meta('loop', 0), 'n'),
  ]);
}

/** Serve the scan from `rows` and every payload/writes read from the same fixtures. */
function serve(
  mock: ReturnType<typeof createStrictDocumentMock>['mock'],
  rows: Row[],
  extra: object[] = [],
) {
  mock.on(ScanCommand).resolves({ Items: [...rows.map((row) => row.meta), ...extra] });
  mock.on(GetCommand).callsFake((input) => ({
    Item: rows.find((row) => row.payload.PK === input.Key.PK && row.payload.SK === input.Key.SK)
      ?.payload,
  }));
  mock.on(QueryCommand).resolves({ Items: [] });
}

const ids = (tuples: CheckpointTuple[]): string[] =>
  tuples.map((tuple) => tuple.checkpoint.id).sort();

describe('listCheckpoints without a thread_id scans every thread (validation suite)', () => {
  it('scans the table for checkpoint META rows and yields every thread and namespace', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    serve(mock, await fixtures(ctx));
    const tuples = await collect(listCheckpoints(ctx, {}));
    expect(ids(tuples)).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(tuples.find((tuple) => tuple.checkpoint.id === 'c4')?.config.configurable).toEqual({
      thread_id: 't2',
      checkpoint_ns: '',
      checkpoint_id: 'c4',
    });
    const input = mock.commandCalls(ScanCommand)[0].args[0].input;
    expect(input.FilterExpression).toContain('begins_with(#pk, :pk)');
    expect(input.ExpressionAttributeValues).toMatchObject({ ':pk': 'CHKPT#', ':sk': 'META#' });
    expect(mock.commandCalls(QueryCommand).length).toBeGreaterThan(0);
  });

  it('narrows the scan to one namespace and applies before, filter and limit in-process', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    serve(mock, await fixtures(ctx));
    expect(
      ids(await collect(listCheckpoints(ctx, { configurable: { checkpoint_ns: 'child' } }))),
    ).toEqual(['c3']);
    expect(
      mock.commandCalls(ScanCommand).at(-1)?.args[0].input.ExpressionAttributeValues,
    ).toMatchObject({ ':sk': 'META#child#' });
    const before = { configurable: { checkpoint_id: 'c3' } };
    expect(ids(await collect(listCheckpoints(ctx, {}, { before })))).toEqual(['c1', 'c2']);
    expect(ids(await collect(listCheckpoints(ctx, {}, { filter: { source: 'input' } })))).toEqual([
      'c1',
    ]);
    expect(await collect(listCheckpoints(ctx, {}, { limit: 2 }))).toHaveLength(2);
  });

  it('matches a checkpoint_id in-process, skips foreign and expired rows, and validates the namespace', async () => {
    const { client, mock } = createStrictDocumentMock();
    const warn = jest.fn();
    const ctx = { ...context(client), logger: { ...SILENT_LOGGER, warn } };
    const rows = await fixtures(ctx);
    const expired = { ...rows[3].meta, ttl: Math.floor(FROZEN_NOW_MS / 1000) - 1 };
    serve(mock, rows.slice(0, 3), [expired, { PK: 'CHKPT#t9', SK: 'META##x', value: {} }]);
    expect(
      ids(await collect(listCheckpoints(ctx, { configurable: { checkpoint_id: 'c2' } }))),
    ).toEqual(['c2']);
    expect(ids(await collect(listCheckpoints(ctx, {})))).toEqual(['c1', 'c2', 'c3']);
    expect(warn).toHaveBeenCalled();
    await expect(
      collect(listCheckpoints(ctx, { configurable: { checkpoint_ns: 'a#b' } })),
    ).rejects.toThrow(/checkpoint_ns/);
  });
});
