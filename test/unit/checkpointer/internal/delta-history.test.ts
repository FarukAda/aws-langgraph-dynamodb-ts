import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { RunnableConfig } from '@langchain/core/runnables';
import type {
  Checkpoint,
  CheckpointPendingWrite,
  CheckpointTuple,
} from '@langchain/langgraph-checkpoint';

import { deltaChannelHistory } from '../../../../src/checkpointer/internal/delta-history';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { FROZEN_NOW_MS } from '../../../shared/helpers/test-setup';

const NOW_SECONDS = Math.floor(FROZEN_NOW_MS / 1000);

/** One ancestor of the chain the walk follows. */
interface Ancestor {
  id: string;
  values?: Record<string, unknown>;
  writes?: CheckpointPendingWrite[];
  /** The `parentConfig` this tuple reports; omitted means the chain ends here. */
  parent?: RunnableConfig | null;
}

function configFor(id: string): RunnableConfig {
  return { configurable: { thread_id: 't', checkpoint_ns: '', checkpoint_id: id } };
}

function tupleFor(ancestor: Ancestor): CheckpointTuple {
  return {
    config: configFor(ancestor.id),
    checkpoint: { id: ancestor.id, channel_values: ancestor.values ?? {} } as Checkpoint,
    metadata: { source: 'loop', step: 1, parents: {} },
    ...(ancestor.writes ? { pendingWrites: ancestor.writes } : {}),
    ...('parent' in ancestor ? { parentConfig: ancestor.parent ?? undefined } : {}),
  };
}

/**
 * A `getTuple` over `chain`, plus a DynamoDB mock holding a META row for every
 * id in `stored` — at that `ttl`, or without one when the value is `null`. An
 * id absent from `stored` is a checkpoint that was never written.
 */
function walkOver(chain: Ancestor[], stored: Record<string, number | null> = {}) {
  const byId = new Map(chain.map((a) => [a.id, tupleFor(a)]));
  const reads: string[] = [];
  const { client, mock } = createStrictDocumentMock();
  mock.on(GetCommand).callsFake((input) => {
    const sk = input.Key.SK as string;
    reads.push(sk);
    const id = sk.split('#').pop() as string;
    if (!(id in stored)) return {};
    const ttl = stored[id];
    return { Item: { PK: input.Key.PK, SK: sk, ...(ttl === null ? {} : { ttl }) } };
  });
  const context: CheckpointerContext = {
    client,
    tableName: 'ckpt',
    serde: {} as CheckpointerContext['serde'],
    logger: SILENT_LOGGER,
  };
  /**
   * `deltaChannelHistory`'s `getTuple` parameter is typed `Promise<...>`; this
   * fake's own lookup is synchronous. `await Promise.resolve(...)` resolves an
   * already-resolved value — it costs one microtask and changes nothing a
   * caller can observe — and is what keeps this a real `async` function whose
   * return type still matches.
   */
  const getTuple = async (config: RunnableConfig): Promise<CheckpointTuple | undefined> =>
    await Promise.resolve(byId.get(config.configurable?.checkpoint_id as string));
  return { context, getTuple, reads };
}

function write(taskId: string, channel: string, value: string): CheckpointPendingWrite {
  return [taskId, channel, value];
}

describe('deltaChannelHistory', () => {
  it('returns the walked writes oldest ancestor first, ascending by task id within one', async () => {
    const { context, getTuple } = walkOver([
      { id: 'c3', parent: configFor('c2') },
      {
        id: 'c2',
        writes: [write('t2', 'messages', 'b'), write('t1', 'messages', 'a')],
        parent: configFor('c1'),
      },
      {
        id: 'c1',
        values: { messages: ['seed'] },
        writes: [write('s1', 'messages', 'old'), write('s2', 'messages', 'newer')],
      },
    ]);

    const history = await deltaChannelHistory(context, getTuple, configFor('c3'), ['messages']);

    expect(history.messages.writes).toEqual([
      write('s1', 'messages', 'old'),
      write('s2', 'messages', 'newer'),
      write('t1', 'messages', 'a'),
      write('t2', 'messages', 'b'),
    ]);
    expect(history.messages.seed).toEqual(['seed']);
  });

  it('keeps the emitted order of two writes one task made to the same channel', async () => {
    const { context, getTuple } = walkOver([
      { id: 'c2', parent: configFor('c1') },
      { id: 'c1', writes: [write('t1', 'messages', 'first'), write('t1', 'messages', 'second')] },
    ]);

    const history = await deltaChannelHistory(context, getTuple, configFor('c2'), ['messages']);

    expect(history.messages.writes).toEqual([
      write('t1', 'messages', 'first'),
      write('t1', 'messages', 'second'),
    ]);
  });

  it('ignores writes for a channel that was not asked for', async () => {
    const { context, getTuple } = walkOver([
      { id: 'c2', parent: configFor('c1') },
      { id: 'c1', writes: [write('t1', 'notes', 'x'), write('t1', 'messages', 'a')] },
    ]);

    const history = await deltaChannelHistory(context, getTuple, configFor('c2'), ['messages']);

    expect(history.messages.writes).toEqual([write('t1', 'messages', 'a')]);
    expect(history.notes).toBeUndefined();
  });

  it('stops collecting a channel once an ancestor has supplied its seed', async () => {
    const { context, getTuple } = walkOver([
      { id: 'c3', parent: configFor('c2') },
      { id: 'c2', values: { messages: ['nearest'] }, parent: configFor('c1') },
      { id: 'c1', writes: [write('t1', 'messages', 'older')] },
    ]);

    const history = await deltaChannelHistory(context, getTuple, configFor('c3'), ['messages']);

    expect(history.messages).toEqual({ writes: [], seed: ['nearest'] });
  });

  it('reports an empty history for a channel no ancestor ever carried', async () => {
    const { context, getTuple } = walkOver([{ id: 'c1' }]);

    const history = await deltaChannelHistory(context, getTuple, configFor('c1'), ['messages']);

    expect(history).toEqual({ messages: { writes: [] } });
  });

  it('ends the walk without a probe when the target checkpoint is unknown', async () => {
    const { context, getTuple, reads } = walkOver([]);

    const history = await deltaChannelHistory(context, getTuple, configFor('gone'), ['messages']);

    expect(history).toEqual({ messages: { writes: [] } });
    expect(reads).toEqual([]);
  });

  it('ends the walk quietly at a parent pointer that names no checkpoint', async () => {
    const { context, getTuple, reads } = walkOver([{ id: 'c2', parent: { configurable: {} } }]);

    const history = await deltaChannelHistory(context, getTuple, configFor('c2'), ['messages']);

    expect(history).toEqual({ messages: { writes: [] } });
    expect(reads).toEqual([]);
  });

  it('ends the walk quietly at a null parentConfig', async () => {
    const { context, getTuple, reads } = walkOver([{ id: 'c2', parent: null }]);

    await expect(
      deltaChannelHistory(context, getTuple, configFor('c2'), ['messages']),
    ).resolves.toEqual({ messages: { writes: [] } });
    expect(reads).toEqual([]);
  });

  it('probes the root namespace for a parent pointer that omits `checkpoint_ns`', async () => {
    const { context, getTuple, reads } = walkOver([
      { id: 'c2', parent: { configurable: { thread_id: 't', checkpoint_id: 'c1' } } },
    ]);

    await deltaChannelHistory(context, getTuple, configFor('c2'), ['messages']);

    expect(reads).toEqual(['META##c1']);
  });

  it('throws for an ancestor whose row is still stored but past its ttl', async () => {
    const { context, getTuple } = walkOver([{ id: 'c2', parent: configFor('c1') }], {
      c1: NOW_SECONDS - 1,
    });

    await expect(
      deltaChannelHistory(context, getTuple, configFor('c2'), ['messages']),
    ).rejects.toMatchObject({ code: ErrorCode.ANCESTOR_EXPIRED });
  });

  it('does not throw for an ancestor whose row is stored and not yet expired', async () => {
    const { context, getTuple } = walkOver([{ id: 'c2', parent: configFor('c1') }], {
      c1: NOW_SECONDS + 1,
    });

    await expect(
      deltaChannelHistory(context, getTuple, configFor('c2'), ['messages']),
    ).resolves.toEqual({ messages: { writes: [] } });
  });

  it('does not throw for a stored ancestor that carries no ttl at all', async () => {
    const { context, getTuple } = walkOver([{ id: 'c2', parent: configFor('c1') }], { c1: null });

    await expect(
      deltaChannelHistory(context, getTuple, configFor('c2'), ['messages']),
    ).resolves.toEqual({ messages: { writes: [] } });
  });
});
