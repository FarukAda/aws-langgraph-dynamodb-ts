import type { RunnableConfig } from '@langchain/core/runnables';
import type {
  CheckpointPendingWrite,
  CheckpointTuple,
  DeltaChannelHistory,
} from '@langchain/langgraph-checkpoint';

import { ancestorExpired, probeAncestor } from './ancestor-probe';
import type { CheckpointerContext } from './setup';

/**
 * A channel's stored value, as the contract being implemented defines it: a
 * `DeltaSnapshot` for a delta channel, a plain value for a channel migrated
 * from a pre-delta type. Taken from the contract rather than restated, because
 * the shape belongs to the caller's graph and is only ever passed through here.
 */
type ChannelSeed = DeltaChannelHistory['seed'];

/** What one walk accumulates: what is still wanted, and what has been found. */
interface Walk {
  remaining: Set<string>;
  writes: Record<string, CheckpointPendingWrite[]>;
  seeds: Record<string, ChannelSeed>;
}

/** An empty accumulator wanting every channel named. */
function startWalk(channels: string[]): Walk {
  const writes: Record<string, CheckpointPendingWrite[]> = {};
  for (const channel of channels) writes[channel] = [];
  return { remaining: new Set(channels), writes, seeds: {} };
}

/**
 * Collect one ancestor's pending writes for the channels still being walked,
 * newest task first within the ancestor, matching the reference walk.
 */
function collectWrites(tuple: CheckpointTuple, walk: Walk): void {
  const perChannel: Record<string, CheckpointPendingWrite[]> = {};
  for (const write of tuple.pendingWrites ?? []) {
    const channel = write[1];
    if (walk.remaining.has(channel)) (perChannel[channel] ??= []).push(write);
  }
  for (const channel of Object.keys(perChannel)) {
    const block = perChannel[channel];
    block.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (let i = block.length - 1; i >= 0; i -= 1) walk.writes[channel].push(block[i]);
  }
}

/**
 * Take the seed for every channel this ancestor stores a value for, and stop
 * walking those channels: the nearest stored value is the one that counts.
 */
function takeSeeds(tuple: CheckpointTuple, walk: Walk): void {
  for (const channel of [...walk.remaining]) {
    if (Object.prototype.hasOwnProperty.call(tuple.checkpoint.channel_values, channel)) {
      walk.seeds[channel] = tuple.checkpoint.channel_values[channel];
      walk.remaining.delete(channel);
    }
  }
}

/**
 * Follow `parentConfig` from `start` until every channel has a seed or the
 * chain ends, feeding each ancestor to {@link collectWrites} and
 * {@link takeSeeds}.
 *
 * An ancestor that cannot be read ends the walk — quietly when it was never
 * written or the cursor names no checkpoint, both ordinary ends of a chain, and
 * with {@link ancestorExpired} when the row is still stored but past its ttl,
 * which is a hole in the thread.
 */
async function walkAncestors(
  context: CheckpointerContext,
  getTuple: (config: RunnableConfig) => Promise<CheckpointTuple | undefined>,
  start: RunnableConfig | undefined,
  walk: Walk,
): Promise<void> {
  let cursor = start;
  while (cursor !== undefined && walk.remaining.size > 0) {
    const tuple = await getTuple(cursor);
    if (tuple === undefined) {
      const stop = await probeAncestor(context, cursor);
      if (stop?.expired) throw ancestorExpired(stop, [...walk.remaining]);
      return;
    }
    collectWrites(tuple, walk);
    takeSeeds(tuple, walk);
    cursor = tuple.parentConfig ?? undefined;
  }
}

/** Shape one channel's accumulated writes and seed into its public history. */
function historyOf(walk: Walk, channel: string): DeltaChannelHistory {
  const writes = walk.writes[channel].slice().reverse();
  return Object.prototype.hasOwnProperty.call(walk.seeds, channel)
    ? { writes, seed: walk.seeds[channel] }
    : { writes };
}

/**
 * Walk a checkpoint's ancestors for the delta channels named, accumulating
 * their writes oldest-first and the nearest stored value of each.
 *
 * Same contract and same result as the inherited implementation
 * (`@langchain/langgraph-checkpoint@1.1.5` `dist/base.js:78`), with one
 * difference that is the reason for overriding it: where the inherited walk
 * meets an ancestor it cannot read it simply stops (`if (tup === void 0)
 * break`), reports no seed, and the consumer rebuilds the channel from its
 * initial value (`@langchain/langgraph@1.4.13` `dist/channels/delta.js:65`).
 * That is silent state loss, and this package can produce it: a ttl is computed
 * per put, so a long-running thread expires its own older checkpoints while the
 * newer ones live on.
 *
 * Accepts: `channels` — the delta channels to rebuild; none returns nothing and
 * reads nothing. `getTuple` — the saver's own, so the walk sees exactly what a
 * reader would. `config` — the checkpoint to walk back from.
 *
 * Returns: per channel, its on-path writes oldest-first and the nearest stored
 * value found. A channel whose value was never stored gets none, which is the
 * consumer's cue to start from its initial value — correctly, because there is
 * nothing to lose.
 *
 * Throws: `ANCESTOR_EXPIRED` when an ancestor a channel still needs exists but
 * has expired ({@link ancestorExpired}). An ancestor that was never written
 * still ends the walk quietly — that is an ordinary root.
 *
 * Guarantees: the walk stops at the first ancestor that answers for every
 * channel, so a deep thread costs reads only as far back as the nearest
 * snapshot.
 */
export async function deltaChannelHistory(
  context: CheckpointerContext,
  getTuple: (config: RunnableConfig) => Promise<CheckpointTuple | undefined>,
  config: RunnableConfig,
  channels: string[],
): Promise<Record<string, DeltaChannelHistory>> {
  if (channels.length === 0) return {};
  const walk = startWalk(channels);
  const target = await getTuple(config);
  await walkAncestors(context, getTuple, target?.parentConfig ?? undefined, walk);

  const result: Record<string, DeltaChannelHistory> = {};
  for (const channel of channels) result[channel] = historyOf(walk, channel);
  return result;
}
