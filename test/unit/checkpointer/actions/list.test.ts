import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
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
  for await (const t of gen) out.push(t);
  return out;
}

describe('listCheckpoints', () => {
  it('skips a META-prefixed row that is not a checkpoint meta item, and warns (C2, I7)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({
      Items: [{ PK: 'CHKPT#t', SK: 'META##x', value: { location: 'INLINE' } }],
    });
    const warn = jest.fn();
    const ctx = { ...context(client), logger: { ...SILENT_LOGGER, warn } };
    const tuples = await collect(
      listCheckpoints(ctx, { configurable: { thread_id: 't', checkpoint_ns: '' } }),
    );
    expect(tuples).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  async function fixtures(client: CheckpointerContext['client']) {
    const ctx = context(client);
    const a = await buildCheckpointItems(ctx, 't', '', checkpoint('c2'), {
      source: 'loop',
      step: 2,
      parents: {},
    } as CheckpointMetadata);
    const b = await buildCheckpointItems(ctx, 't', '', checkpoint('c1'), {
      source: 'input',
      step: 1,
      parents: {},
    } as CheckpointMetadata);
    const metas: Record<string, CheckpointMetaItem> = { c2: a.meta, c1: b.meta };
    const payloads: Record<string, CheckpointPayloadItem> = { c2: a.payload, c1: b.payload };
    return { metas, payloads };
  }

  function wire(
    mock: ReturnType<typeof createStrictDocumentMock>['mock'],
    data: {
      metas: Record<string, CheckpointMetaItem>;
      payloads: Record<string, CheckpointPayloadItem>;
    },
  ) {
    mock.on(QueryCommand).callsFake((input) => {
      const prefix = input.ExpressionAttributeValues[':skPrefix'] as string;
      if (prefix.startsWith('META')) return { Items: [data.metas.c2, data.metas.c1] };
      return { Items: [] };
    });
    mock.on(GetCommand).callsFake((input) => {
      const sk = input.Key.SK as string;
      return { Item: sk.endsWith('c2') ? data.payloads.c2 : data.payloads.c1 };
    });
  }

  it('yields every checkpoint newest-first', async () => {
    const { client, mock } = createStrictDocumentMock();
    wire(mock, await fixtures(client));
    const tuples = await collect(
      listCheckpoints(context(client), { configurable: { thread_id: 't' } }),
    );
    expect(tuples.map((t) => t.config.configurable?.checkpoint_id)).toEqual(['c2', 'c1']);
  });

  it('respects limit', async () => {
    const { client, mock } = createStrictDocumentMock();
    wire(mock, await fixtures(client));
    const tuples = await collect(
      listCheckpoints(context(client), { configurable: { thread_id: 't' } }, { limit: 1 }),
    );
    expect(tuples.map((t) => t.config.configurable?.checkpoint_id)).toEqual(['c2']);
  });

  it('respects before (older than the given checkpoint id)', async () => {
    const { client, mock } = createStrictDocumentMock();
    wire(mock, await fixtures(client));
    const tuples = await collect(
      listCheckpoints(
        context(client),
        { configurable: { thread_id: 't' } },
        { before: { configurable: { checkpoint_id: 'c2' } } },
      ),
    );
    expect(tuples.map((t) => t.config.configurable?.checkpoint_id)).toEqual(['c1']);
  });

  it('respects a metadata filter', async () => {
    const { client, mock } = createStrictDocumentMock();
    wire(mock, await fixtures(client));
    const tuples = await collect(
      listCheckpoints(
        context(client),
        { configurable: { thread_id: 't' } },
        { filter: { source: 'input' } },
      ),
    );
    expect(tuples.map((t) => t.config.configurable?.checkpoint_id)).toEqual(['c1']);
  });

  it('skips checkpoints whose payload is missing', async () => {
    const { client, mock } = createStrictDocumentMock();
    const data = await fixtures(client);
    mock.on(QueryCommand).callsFake((input) => {
      const prefix = input.ExpressionAttributeValues[':skPrefix'] as string;
      return prefix.startsWith('META') ? { Items: [data.metas.c2] } : { Items: [] };
    });
    mock.on(GetCommand).resolves({});
    const tuples = await collect(
      listCheckpoints(context(client), { configurable: { thread_id: 't' } }),
    );
    expect(tuples).toEqual([]);
  });

  it('filters to a single checkpoint id when config.configurable.checkpoint_id is set', async () => {
    const { client, mock } = createStrictDocumentMock();
    wire(mock, await fixtures(client));
    const tuples = await collect(
      listCheckpoints(context(client), {
        configurable: { thread_id: 't', checkpoint_id: 'c1' },
      }),
    );
    expect(tuples.map((t) => t.config.configurable?.checkpoint_id)).toEqual(['c1']);
  });
});
