import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointPendingWrite,
} from '@langchain/langgraph-checkpoint';

import { decodePayload } from '../../shared/codec/codec';
import { mapWithConcurrency } from '../../shared/concurrency';
import { DEFAULT_READ_CONCURRENCY } from '../../shared/constants';
import type { DocItem } from '../../shared/dynamodb/types';
import type { CheckpointMetaItem, CheckpointPayloadItem, CheckpointWriteItem } from '../types';
import { codecDeps } from './item-writer';
import type { CheckpointerContext } from './setup';

/**
 * Narrow a raw row to a {@link CheckpointMetaItem}, or `undefined` for a row
 * that merely shares the `META#` sort-key prefix. Replaces an unchecked cast
 * at the one boundary where a row may not have been written by this adapter.
 */
export function narrowMetaItem(raw: DocItem): CheckpointMetaItem | undefined {
  return typeof raw.checkpointId === 'string' &&
    typeof raw.checkpointNs === 'string' &&
    raw.metadata !== undefined
    ? (raw as CheckpointMetaItem)
    : undefined;
}

/**
 * Decode the checkpoint stored in a PAYLOAD item. `threadId` is the caller's
 * (from the config), never the row's: it scopes which S3 object the row may
 * point at, so it must come from the partition the caller asked for.
 */
export async function readCheckpoint(
  context: CheckpointerContext,
  item: CheckpointPayloadItem,
  threadId: string,
): Promise<Checkpoint> {
  return decodePayload<Checkpoint>(item.checkpoint, codecDeps(context), [threadId]);
}

/** Decode the metadata stored in a META item; see {@link readCheckpoint} for `threadId`. */
export async function readMetadata(
  context: CheckpointerContext,
  item: CheckpointMetaItem,
  threadId: string,
): Promise<CheckpointMetadata> {
  return decodePayload<CheckpointMetadata>(item.metadata, codecDeps(context), [threadId]);
}

/**
 * Drop rows a later `putWrites` call added for a task and channel an earlier
 * call had already committed.
 *
 * A regular write's index is its position in the caller's array, so a retried
 * task whose write mix changed can place an already-committed channel at a
 * second index — a new row, which would replay that channel's value twice. For
 * an accumulating channel (a `messages` add-reducer, a Topic) that
 * double-counts. Every row carries the `writeGroup` of the call that wrote it,
 * which distinguishes that case from a channel a *single* call legitimately
 * wrote more than once (a task emitting two Sends), where both values must
 * survive.
 *
 * Write groups are time-ordered ULIDs, so the smallest one for a `(task,
 * channel)` pair identifies the earliest committed call — first-write-wins,
 * the same rule the write-side guard applies, extended to the case the guard
 * cannot see. Selecting by *order encountered* would not do: rows arrive
 * sorted by index, and a retry emitting fewer writes moves an
 * already-committed channel to a smaller index, where it sorts ahead of the
 * original row and would hand back the later call's value instead. The
 * superseded row stays in DynamoDB and is removed by `deleteThread` or TTL
 * like any other.
 *
 * Identity is `(task, channel, occurrence)`, not `(task, channel)`. Keying on
 * the channel alone treated *any* second row for a channel as a superseding
 * duplicate — including one a retry added at an occurrence no earlier call had
 * ever written, which the write-side guard accepted cleanly. That row was then
 * discarded on read, silently returning fewer values than were written, with
 * `putWrites()` having reported success. For that specific shape — a retry
 * that legitimately emits a channel *more* often than the original call —
 * keeping the occurrence restores the upstream outcome: `MemorySaver` keys
 * first-write-wins on `(taskId, idx)`, so a grown retry keeps both values
 * there too. That is not a claim of parity in general: a retry that reorders
 * or shrinks its writes is still resolved to the earliest call per `(task,
 * channel, occurrence)` as above, which is what keeps an accumulating channel
 * from being double-counted — a case `MemorySaver` does not have to handle.
 */
export function dropSupersededWrites(items: CheckpointWriteItem[]): CheckpointWriteItem[] {
  const identity = (item: CheckpointWriteItem): string =>
    JSON.stringify([item.taskId, item.channel, item.occurrence ?? 0]);
  const earliestGroup = new Map<string, string>();
  for (const item of items) {
    const id = identity(item);
    const seen = earliestGroup.get(id);
    if (seen === undefined || item.writeGroup < seen) earliestGroup.set(id, item.writeGroup);
  }
  return items.filter((item) => earliestGroup.get(identity(item)) === item.writeGroup);
}

/** Decode WRITE items into `[taskId, channel, value]` pending-write tuples. */
export async function toPendingWrites(
  context: CheckpointerContext,
  items: CheckpointWriteItem[],
  threadId: string,
): Promise<CheckpointPendingWrite[]> {
  const deps = codecDeps(context);
  const live = dropSupersededWrites(items);
  const values = await mapWithConcurrency(live, DEFAULT_READ_CONCURRENCY, (item) =>
    decodePayload(item.value, deps, [threadId]),
  );
  return live.map((item, index): CheckpointPendingWrite => [
    item.taskId,
    item.channel,
    values[index],
  ]);
}
