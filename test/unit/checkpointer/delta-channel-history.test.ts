import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { buildCheckpointItems } from '../../../src/checkpointer/internal/item-writer';
import type { CheckpointerContext } from '../../../src/checkpointer/internal/setup';
import { DynamoDBSaver } from '../../../src/checkpointer/saver';
import { ErrorCode } from '../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../shared/helpers/ddb-mock';
import { FROZEN_NOW_MS } from '../../shared/helpers/test-setup';

const serde = {
  dumpsTyped: async (value: unknown): Promise<[string, Uint8Array]> => [
    'json',
    new TextEncoder().encode(JSON.stringify(value)),
  ],
  loadsTyped: async (_t: string, d: Uint8Array | string): Promise<unknown> =>
    JSON.parse(typeof d === 'string' ? d : new TextDecoder().decode(d)),
};

const meta: CheckpointMetadata = { source: 'loop', step: 1, parents: {} };
const NOW_SECONDS = Math.floor(FROZEN_NOW_MS / 1000);
const HOUR = 3600;

function checkpoint(id: string, values: Record<string, unknown>): Checkpoint {
  return {
    v: 4,
    id,
    ts: '',
    channel_values: values,
    channel_versions: {},
    versions_seen: {},
  } as Checkpoint;
}

/** One checkpoint of the thread: what it stores, who its parent is, when it expires. */
interface Row {
  id: string;
  values: Record<string, unknown>;
  parent?: string;
  expiresIn: number;
}

/**
 * A saver over a thread of `rows`, each readable at its own key. A row whose
 * `ttl` has passed is still returned by the mock, exactly as DynamoDB does
 * until its sweep catches up — the library is what has to treat it as gone.
 */
async function saverOver(rows: Row[]): Promise<DynamoDBSaver> {
  const { client, mock } = createStrictDocumentMock();
  const ctx: CheckpointerContext = { client, tableName: 'ckpt', serde, logger: SILENT_LOGGER };
  const built = await Promise.all(
    rows.map((row) =>
      buildCheckpointItems(
        ctx,
        't',
        '',
        checkpoint(row.id, row.values),
        meta,
        row.parent,
        NOW_SECONDS + row.expiresIn,
      ),
    ),
  );
  mock.on(GetCommand).callsFake((input) => {
    const sk = input.Key.SK as string;
    const item = built.find((b) => b.meta.SK === sk || b.payload.SK === sk);
    if (!item) return {};
    return { Item: sk.startsWith('PAYLOAD') ? item.payload : item.meta };
  });
  mock.on(QueryCommand).resolves({ Items: [] });
  return new DynamoDBSaver({ tableName: 'ckpt', client, serde } as never);
}

function historyOf(saver: DynamoDBSaver, checkpointId: string, channels: string[]) {
  return saver.getDeltaChannelHistory({
    config: { configurable: { thread_id: 't', checkpoint_ns: '', checkpoint_id: checkpointId } },
    channels,
  });
}

/**
 * A delta channel keeps only what changed at each step, so its value is rebuilt
 * from the nearest ancestor that stored one. This package computes a TTL per
 * put, which expires that ancestor while its descendants live on.
 *
 * The inherited walk stops at an ancestor it cannot read (`if (tup === void 0)
 * break` — @langchain/langgraph-checkpoint@1.1.5 dist/base.js:88), reports no
 * `seed`, and the consumer restarts the channel from its initial value
 * (`fromCheckpoint(undefined)` — @langchain/langgraph@1.4.13
 * dist/channels/delta.js:65). `DynamoDBSaver` overrides it so that hole is
 * raised instead of silently swallowed.
 */
describe('delta-channel history across a TTL boundary', () => {
  it('throws ANCESTOR_EXPIRED when a channel still needs an expired ancestor', async () => {
    const saver = await saverOver([
      { id: 'c1', values: { messages: ['first'] }, expiresIn: -HOUR },
      { id: 'c2', values: {}, parent: 'c1', expiresIn: HOUR },
    ]);

    await expect(historyOf(saver, 'c2', ['messages'])).rejects.toMatchObject({
      code: ErrorCode.ANCESTOR_EXPIRED,
      context: { threadId: 't', checkpointId: 'c1' },
    });
  });

  it('names the thread, the checkpoint and every unresolved channel in the message', async () => {
    const saver = await saverOver([
      { id: 'c1', values: { messages: ['first'], notes: ['a'] }, expiresIn: -HOUR },
      { id: 'c2', values: {}, parent: 'c1', expiresIn: HOUR },
    ]);

    const error = await historyOf(saver, 'c2', ['messages', 'notes']).catch((e: Error) => e);

    expect(error.message).toContain('"c1"');
    expect(error.message).toContain('"t"');
    expect(error.message).toContain('"messages"');
    expect(error.message).toContain('"notes"');
    expect(error.message).toContain('snapshotFrequency');
  });

  it('returns the nearest stored value when every ancestor is live', async () => {
    const saver = await saverOver([
      { id: 'c1', values: { messages: ['first'] }, expiresIn: HOUR },
      { id: 'c2', values: {}, parent: 'c1', expiresIn: HOUR },
    ]);

    const history = await historyOf(saver, 'c2', ['messages']);

    expect(history.messages.seed).toEqual(['first']);
  });

  it('ends the walk quietly at a parent that was never written', async () => {
    const saver = await saverOver([{ id: 'c2', values: {}, parent: 'gone', expiresIn: HOUR }]);

    const history = await historyOf(saver, 'c2', ['messages']);

    expect(history.messages.writes).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(history.messages, 'seed')).toBe(false);
  });

  it('never reaches an expired ancestor a nearer one has already answered for', async () => {
    const saver = await saverOver([
      { id: 'c1', values: { messages: ['oldest'] }, expiresIn: -HOUR },
      { id: 'c2', values: { messages: ['newer'] }, parent: 'c1', expiresIn: HOUR },
      { id: 'c3', values: {}, parent: 'c2', expiresIn: HOUR },
    ]);

    const history = await historyOf(saver, 'c3', ['messages']);

    expect(history.messages.seed).toEqual(['newer']);
  });

  it('reads nothing and returns nothing when no channels are named', async () => {
    const saver = await saverOver([{ id: 'c1', values: {}, expiresIn: HOUR }]);

    await expect(historyOf(saver, 'c1', [])).resolves.toEqual({});
  });
});
