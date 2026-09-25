/**
 * Hides how a delta channel's history is rebuilt, and what a hole in it means.
 *
 * A delta channel stores a full value only every `snapshotFrequency` updates,
 * so its value at a checkpoint is its last snapshot plus the writes since,
 * collected by walking parent pointers. The walk, the order the writes are
 * collected in, and the one read that tells an expired ancestor (a hole to
 * report) from one that never existed (the history's true start) are decided
 * here.
 */

import type { RunnableConfig } from '@langchain/core/runnables';
import type {
  CheckpointPendingWrite,
  CheckpointTuple,
  DeltaChannelHistory,
} from '@langchain/langgraph-checkpoint';

import { nowSeconds } from '../../shared/clock';
import type { AttributeMap } from '../../shared/dynamodb/client';
import { withDynamoDBRetry, retryFor } from '../../shared/dynamodb/retry';
import { isExpiredRow } from '../../shared/dynamodb/table-schema';
import { DynamoDBLangGraphError } from '../../shared/errors/base-error';
import { ErrorCode } from '../../shared/errors/error-code';
import { truncateForLog, truncateLabelsForLog } from '../../shared/logging/truncate';
import { metaRowKey } from './rows';
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
 * The parent pointer a tuple carries, re-given the caller's `signal`.
 *
 * A tuple's `config` and `parentConfig` are built by `assembleTuple` as bare
 * `{ configurable }` addresses, and they stay that way: they are handed to
 * whoever called `getTuple`, who may keep a `parentConfig` and read from it
 * later, long after this call's signal has fired. So the signal is re-attached
 * here, to the cursor this walk reads with, rather than stamped onto the value
 * the tuple publishes.
 *
 * The cursor is a `RunnableConfig`, and `config.signal` is how every reader in
 * this package already takes a cancel, so nothing new carries it: the second
 * hop is cancellable for exactly the reason the first one is.
 */
function cursorFor(
  parent: RunnableConfig | undefined,
  signal: AbortSignal | undefined,
): RunnableConfig | undefined {
  if (parent === undefined || signal === undefined) return parent;
  return { ...parent, signal };
}

/**
 * Follow `parentConfig` from `from.start` until every channel has a seed or the
 * chain ends, feeding each ancestor to {@link collectWrites} and
 * {@link takeSeeds}.
 *
 * An ancestor that cannot be read ends the walk — quietly when it was never
 * written or the cursor names no checkpoint, both ordinary ends of a chain, and
 * with {@link ancestorExpired} when the row is still stored but past its ttl,
 * which is a hole in the thread.
 *
 * `from.signal` cancels every hop, not just the first. The chain is unbounded
 * in principle — a delta channel rebuilds from the nearest ancestor that stored
 * a value — and each hop is a `getTuple`, which can cost an S3 download, so a
 * walk that could not be stopped part-way was the one read in this package that
 * ignored the cancel it was given. A cancel is read before the request is sent,
 * so the hop the signal fires on is the last read the call makes.
 */
async function walkAncestors(
  context: CheckpointerContext,
  getTuple: (config: RunnableConfig) => Promise<CheckpointTuple | undefined>,
  walk: Walk,
  from: { start: RunnableConfig | undefined; signal: AbortSignal | undefined },
): Promise<void> {
  let cursor = cursorFor(from.start, from.signal);
  while (cursor !== undefined && walk.remaining.size > 0) {
    const tuple = await getTuple(cursor);
    if (tuple === undefined) {
      const stop = await probeAncestor(context, cursor);
      if (stop?.expired) throw ancestorExpired(stop, [...walk.remaining]);
      return;
    }
    collectWrites(tuple, walk);
    takeSeeds(tuple, walk);
    cursor = cursorFor(tuple.parentConfig, from.signal);
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
 * reader would. `config` — the checkpoint to walk back from. `config.signal` —
 * cancels the whole walk: it is re-attached to each ancestor cursor
 * ({@link cursorFor}), because the pointer a tuple carries is a bare address.
 *
 * Returns: per channel, its on-path writes oldest-first and the nearest stored
 * value found. A channel whose value was never stored gets none, which is the
 * consumer's cue to start from its initial value — correctly, because there is
 * nothing to lose.
 *
 * Throws: `ANCESTOR_EXPIRED` when an ancestor a channel still needs exists but
 * has expired ({@link ancestorExpired}). An ancestor that was never written
 * still ends the walk quietly — that is an ordinary root. `ABORTED` when the
 * signal fires, at whichever hop it fires on, and in preference to a diagnosis
 * of the stop: a walk cancelled just as it reached an expired ancestor reports
 * the cancel, since the caller stopped waiting for the answer either way.
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
  await walkAncestors(context, getTuple, walk, {
    start: target?.parentConfig,
    signal: config.signal,
  });

  const result: Record<string, DeltaChannelHistory> = {};
  for (const channel of channels) result[channel] = historyOf(walk, channel);
  return result;
}

/** Where an ancestor walk stopped, and whether that stop is a hole in the thread. */
export interface WalkStop {
  threadId: string;
  checkpointId: string;
  /** True when the row is still stored but past its `ttl`, rather than never written. */
  expired: boolean;
}

/**
 * Read the META row an ancestor walk could not follow, **ignoring expiry**, to
 * tell "this checkpoint was never written" apart from "it expired out from
 * under its own descendants".
 *
 * Every other read in this package treats an expired row as absent, which is
 * the right rule for a reader asking for state. Here the distinction is the
 * whole point: one is an ordinary root, the other is data loss.
 *
 * Accepts: `config` — the parent pointer a walk stopped at. `config.signal` —
 * cancels the read, and is read before it is sent. The walk re-attaches the
 * caller's signal to every cursor, so the probe takes its cancel from the same
 * place every other reader in this package takes it, rather than from a
 * parameter of its own.
 *
 * Returns: whether that checkpoint exists and whether it has expired, or
 * `undefined` when the config names no thread or no checkpoint — such a pointer
 * addresses nothing that could have expired, so the walk has simply run out of
 * chain.
 *
 * Throws: whatever the read throws after retries; `ABORTED` when the signal
 * has already fired, which is answered in preference to the expiry this read
 * exists to diagnose — a caller who cancelled is owed its own stop, and is no
 * longer waiting to be told why the walk ended.
 *
 * Guarantees: the read ignores the ttl, deliberately. Every other read in this
 * package treats an expired row as absent, which is the right rule for a reader
 * asking for state; here the distinction is the whole point, because one answer
 * is an ordinary root and the other is data loss.
 */
export async function probeAncestor(
  context: CheckpointerContext,
  config: RunnableConfig,
): Promise<WalkStop | undefined> {
  const ids = config.configurable;
  const threadId: string | undefined = ids?.thread_id;
  const checkpointId: string | undefined = ids?.checkpoint_id;
  if (typeof threadId !== 'string' || typeof checkpointId !== 'string') return undefined;
  const checkpointNs: string = ids?.checkpoint_ns ?? '';
  const result = await withDynamoDBRetry(
    (request) =>
      context.client.get(
        {
          TableName: context.tableName,
          Key: metaRowKey({ threadId, checkpointNs, checkpointId }),
          ConsistentRead: true,
        },
        request,
      ),
    retryFor(context, config.signal),
  );
  const row = result.Item as AttributeMap | undefined;
  return {
    threadId,
    checkpointId,
    expired: row !== undefined && isExpiredRow(row, nowSeconds()),
  };
}

/**
 * The error a read raises when a delta channel's history has a hole in it.
 *
 * Accepts: `stop` — the expired ancestor the walk reached. `channels` — the
 * delta channels that still needed it, named in the message so the operator
 * knows what was lost.
 *
 * Returns: the error, coded `ANCESTOR_EXPIRED` and carrying the thread and
 * checkpoint. The message bounds all three: after the first hop the walk's
 * cursor is a row's own `parentConfig`, so the identifiers it names come off a
 * row, and `channels` is checked for being an array of strings and for nothing
 * else — neither how many nor how long. `context` carries both identifiers
 * whole, which is what a caller branches on.
 *
 * Throws: nothing — it builds the error, the caller throws it.
 *
 * Guarantees: returning the partial history instead would hand the caller a
 * channel rebuilt from its initial value plus whatever writes survived — a
 * shorter message list, say, with nothing to say that anything is missing. The
 * reference contract has no way to express "incomplete", so refusing the read
 * is the only honest answer.
 */
export function ancestorExpired(stop: WalkStop, channels: string[]): DynamoDBLangGraphError {
  const named = truncateLabelsForLog(channels)
    .map((channel) => `"${channel}"`)
    .join(', ');
  return new DynamoDBLangGraphError(
    `checkpoint "${truncateForLog(stop.checkpointId)}" of thread ` +
      `"${truncateForLog(stop.threadId)}" has expired, but later ` +
      `checkpoints still need it to reconstruct ${named}. ` +
      'A delta channel writes a full snapshot only every `snapshotFrequency` updates and leaves ' +
      'itself out of the checkpoints in between, so its value is rebuilt from an earlier ' +
      'ancestor — which a per-checkpoint ttl expires while its descendants live on. Lower ' +
      '`snapshotFrequency` (1 makes every checkpoint self-contained), or do not configure a ttl ' +
      'on threads that use delta channels.',
    ErrorCode.ANCESTOR_EXPIRED,
    { threadId: stop.threadId, checkpointId: stop.checkpointId },
  );
}
