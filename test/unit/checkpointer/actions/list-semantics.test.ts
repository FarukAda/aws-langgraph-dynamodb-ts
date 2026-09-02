import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
} from '@langchain/langgraph-checkpoint';

import { listCheckpoints } from '../../../../src/checkpointer/actions/list';
import { buildCheckpointItems } from '../../../../src/checkpointer/internal/item-writer';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
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
  for await (const t of gen) out.push(t);
  return out;
}

describe('list() semantics and cost (CKPT-05, CKPT-07)', () => {
  const meta: CheckpointMetadata = { source: 'loop', step: 1, parents: {} };
  type Built = Awaited<ReturnType<typeof buildCheckpointItems>>;

  /** Serve META queries per namespace prefix, WRITE queries as empty, and payloads by sort key. */
  function serve(mock: ReturnType<typeof createStrictDocumentMock>['mock'], built: Built[]) {
    mock.on(QueryCommand).callsFake((input) => {
      const prefix = input.ExpressionAttributeValues[':skPrefix'] as string;
      if (!prefix.startsWith('META')) return { Items: [] };
      return { Items: built.map((b) => b.meta).filter((m) => m.SK.startsWith(prefix)) };
    });
    mock.on(GetCommand).callsFake((input) => ({
      Item: built.find((b) => b.payload.SK === input.Key.SK || b.meta.SK === input.Key.SK)?.[
        (input.Key.SK as string).startsWith('PAYLOAD') ? 'payload' : 'meta'
      ],
    }));
  }

  it('covers every namespace of the thread when checkpoint_ns is not given', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const root = await buildCheckpointItems(ctx, 't', '', checkpoint('c1'), meta, 'n1');
    const child = await buildCheckpointItems(ctx, 't', 'child:abc', checkpoint('c2'), meta, 'n2');
    serve(mock, [root, child]);
    const tuples = await collect(listCheckpoints(ctx, { configurable: { thread_id: 't' } }));
    expect(tuples.map((t) => t.config.configurable?.checkpoint_ns).sort()).toEqual([
      '',
      'child:abc',
    ]);
    expect(
      mock.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues?.[':skPrefix'],
    ).toBe('META#');
  });

  it('addresses one checkpoint with a GetItem when checkpoint_id is set, never scanning the namespace', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const one = await buildCheckpointItems(ctx, 't', '', checkpoint('c1'), meta, 'n1');
    serve(mock, [one]);
    const tuples = await collect(
      listCheckpoints(ctx, { configurable: { thread_id: 't', checkpoint_id: 'c1' } }),
    );
    expect(tuples.map((t) => t.checkpoint.id)).toEqual(['c1']);
    const metaQueries = mock
      .commandCalls(QueryCommand)
      .filter((c) =>
        (c.args[0].input.ExpressionAttributeValues?.[':skPrefix'] as string).startsWith('META'),
      );
    expect(metaQueries).toHaveLength(0);
    expect(mock.commandCalls(GetCommand).some((c) => c.args[0].input.Key?.SK === 'META##c1')).toBe(
      true,
    );
  });

  it('bounds `before` in the key condition when the namespace is explicit, and not across namespaces', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    const before = { configurable: { checkpoint_id: 'c5' } };
    await collect(
      listCheckpoints(
        context(client),
        { configurable: { thread_id: 't', checkpoint_ns: '' } },
        { before },
      ),
    );
    const bounded = mock.commandCalls(QueryCommand)[0].args[0].input;
    expect(bounded.KeyConditionExpression).toContain('BETWEEN');
    expect(bounded.ExpressionAttributeValues?.[':before']).toBe('META##c5');
    await collect(
      listCheckpoints(context(client), { configurable: { thread_id: 't' } }, { before }),
    );
    const unbounded = mock.commandCalls(QueryCommand)[1].args[0].input;
    expect(unbounded.KeyConditionExpression).toContain('begins_with');
    expect(unbounded.ExpressionAttributeValues?.[':before']).toBeUndefined();
  });

  it('decodes metadata once per tuple when a filter is set', async () => {
    const { client, mock } = createStrictDocumentMock();
    const loads = jest.fn(serde.loadsTyped);
    const ctx = { ...context(client), serde: { ...serde, loadsTyped: loads } };
    const one = await buildCheckpointItems(ctx, 't', '', checkpoint('c1'), meta, 'n1');
    serve(mock, [one]);
    const tuples = await collect(
      listCheckpoints(ctx, { configurable: { thread_id: 't' } }, { filter: { step: 1 } }),
    );
    expect(tuples).toHaveLength(1);
    // one decode for the metadata (filter + tuple), one for the checkpoint payload
    expect(loads).toHaveBeenCalledTimes(2);
  });

  it('stops after the yield that reaches limit without fetching the next page', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const first = await buildCheckpointItems(ctx, 't', '', checkpoint('c2'), meta, 'n2');
    const second = await buildCheckpointItems(ctx, 't', '', checkpoint('c1'), meta, 'n1');
    let metaPages = 0;
    mock.on(QueryCommand).callsFake((input) => {
      const prefix = input.ExpressionAttributeValues[':skPrefix'] as string;
      if (!prefix.startsWith('META')) return { Items: [] };
      metaPages += 1;
      return metaPages === 1
        ? { Items: [first.meta], LastEvaluatedKey: { PK: 'CHKPT#t', SK: first.meta.SK } }
        : { Items: [second.meta] };
    });
    mock.on(GetCommand).resolves({ Item: first.payload });
    const tuples = await collect(
      listCheckpoints(ctx, { configurable: { thread_id: 't' } }, { limit: 1 }),
    );
    expect(tuples.map((t) => t.checkpoint.id)).toEqual(['c2']);
    expect(metaPages).toBe(1);
  });

  it('reads payloads and writes eventually consistently on the list path', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const one = await buildCheckpointItems(ctx, 't', '', checkpoint('c1'), meta, 'n1');
    serve(mock, [one]);
    await collect(listCheckpoints(ctx, { configurable: { thread_id: 't' } }));
    const payloadGet = mock
      .commandCalls(GetCommand)
      .find((c) => (c.args[0].input.Key?.SK as string).startsWith('PAYLOAD'));
    expect(payloadGet?.args[0].input.ConsistentRead).not.toBe(true);
    const writesQuery = mock
      .commandCalls(QueryCommand)
      .find((c) =>
        (c.args[0].input.ExpressionAttributeValues?.[':skPrefix'] as string).startsWith('WRITE'),
      );
    expect(writesQuery?.args[0].input.ConsistentRead).not.toBe(true);
  });
});

describe('list() addressed by checkpoint_id: edge cases', () => {
  const meta: CheckpointMetadata = { source: 'loop', step: 1, parents: {} };

  it('yields nothing when the addressed checkpoint does not exist', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    const tuples = await collect(
      listCheckpoints(context(client), {
        configurable: { thread_id: 't', checkpoint_id: 'missing' },
      }),
    );
    expect(tuples).toEqual([]);
  });

  it('yields nothing when `before` excludes the addressed checkpoint', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const one = await buildCheckpointItems(ctx, 't', '', checkpoint('c5'), meta, 'n1');
    mock.on(GetCommand).resolves({ Item: one.meta });
    const tuples = await collect(
      listCheckpoints(
        ctx,
        { configurable: { thread_id: 't', checkpoint_id: 'c5' } },
        {
          before: { configurable: { checkpoint_id: 'c5' } },
        },
      ),
    );
    expect(tuples).toEqual([]);
  });
});

describe('list() skips expired checkpoints (CKPT-10)', () => {
  const meta: CheckpointMetadata = { source: 'loop', step: 1, parents: {} };

  it('omits a META row past its ttl and asks DynamoDB to filter them too', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const now = Math.floor(FROZEN_NOW_MS / 1000);
    const expired = await buildCheckpointItems(
      ctx,
      't',
      '',
      checkpoint('c2'),
      meta,
      'n2',
      undefined,
      now - 1,
    );
    const live = await buildCheckpointItems(
      ctx,
      't',
      '',
      checkpoint('c1'),
      meta,
      'n1',
      undefined,
      now + 60,
    );
    mock.on(QueryCommand).callsFake((input) => {
      const prefix = input.ExpressionAttributeValues[':skPrefix'] as string;
      return prefix.startsWith('META') ? { Items: [expired.meta, live.meta] } : { Items: [] };
    });
    mock.on(GetCommand).resolves({ Item: live.payload });
    const tuples = await collect(listCheckpoints(ctx, { configurable: { thread_id: 't' } }));
    expect(tuples.map((t) => t.checkpoint.id)).toEqual(['c1']);
    expect(mock.commandCalls(QueryCommand)[0].args[0].input.FilterExpression).toContain('#ttl');
  });
});
