import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointPendingWrite,
} from '@langchain/langgraph-checkpoint';

import { decodePayload } from '../../shared/codec/codec';
import { mapWithConcurrency } from '../../shared/concurrency';
import { DEFAULT_READ_CONCURRENCY } from '../../shared/constants';
import type { DocItem } from '../../shared/dynamodb/client';
import { assertReadableRow } from '../../shared/dynamodb/table-schema';
import { truncateForLog } from '../../shared/logging/truncate';
import type { CheckpointMetaItem, CheckpointPayloadItem, CheckpointWriteItem } from '../types';
import { codecDeps } from './item-writer';
import { metaSortKey, partitionKey } from './keys';
import type { CheckpointerContext } from './setup';
import { dropSupersededWrites } from './write-dedup';

/**
 * Narrow a raw row to a {@link CheckpointMetaItem}.
 *
 * Accepts: `raw` — any row carrying the `META#` sort-key prefix, which on a
 * shared table another writer can produce too.
 *
 * Returns: the item, or undefined for a row that merely shares the prefix, and
 * for one whose own `threadId`/`checkpointNs`/`checkpointId` disagree with the
 * DynamoDB key it was found at. The test is on the attributes a checkpoint must
 * have, not on a cast: this is the one boundary where a row may not have been
 * written by this adapter. A `metadata` of `null` is refused here, since
 * dereferencing it later raised a raw `TypeError`.
 *
 * Throws: `FORMAT_UNSUPPORTED` for a row a newer version wrote — checked
 * **before** the shape, as every other read of this package's rows checks it,
 * so a row a newer release wrote is reported as newer rather than judged
 * against attribute names it may no longer use. Skipping it would report a
 * thread as shorter than it is.
 *
 * Guarantees: a row's attributes are bound to the partition it lives in. Those
 * attributes name the S3 scope the row's payloads are read under and the thread
 * the assembled tuple reports, so a writer confined to its own partition could
 * otherwise hand back another tenant's offloaded payload under that tenant's
 * `thread_id` — the same binding `narrowStoreRecord` makes for store items. The
 * binding is judged under this release's rules, which is why it is judged only
 * for a row this release can read.
 */
export function narrowMetaItem(raw: DocItem): CheckpointMetaItem | undefined {
  /**
   * The version first. A row a newer version wrote is not a foreign row to
   * skip, and this release's names for its attributes are not that release's,
   * so testing the shape first decides a row is foreign whenever a later
   * format renamed what this one reads.
   */
  assertReadableRow(raw, 'checkpoint');
  const isCheckpoint =
    typeof raw.threadId === 'string' &&
    typeof raw.checkpointId === 'string' &&
    typeof raw.checkpointNs === 'string' &&
    typeof raw.metadata === 'object' &&
    raw.metadata !== null;
  if (!isCheckpoint) return undefined;
  const item = raw as CheckpointMetaItem;
  const consistent =
    item.PK === partitionKey(item.threadId) &&
    item.SK === metaSortKey(item.checkpointNs, item.checkpointId);
  return consistent ? item : undefined;
}

/**
 * Narrow a candidate head row, saying so when it is not one of ours.
 *
 * Accepts: `raw` — the row a newest-first read returned, or undefined when it
 * returned none.
 *
 * Returns: the item, or undefined for an absent or foreign row — logged at
 * `warn` in the second case, because a foreign row at the head of a thread is
 * an operator's problem even though this read recovers from it.
 *
 * Throws: as {@link narrowMetaItem}.
 *
 * Guarantees: a foreign row is skipped, never returned. Returning one made
 * `assembleTuple` miss its payload and report the thread as empty, so LangGraph
 * started a new run on top of the real history.
 */
export function narrowHead(
  context: CheckpointerContext,
  raw: DocItem | undefined,
): CheckpointMetaItem | undefined {
  if (raw === undefined) return undefined;
  const meta = narrowMetaItem(raw);
  if (!meta) {
    context.logger.warn('getTuple: skipped a row that is not a checkpoint meta item', {
      sortKey: truncateForLog(raw.SK as string),
    });
  }
  return meta;
}

/**
 * Decode the checkpoint stored in a PAYLOAD item.
 *
 * Accepts: `threadId` — the **caller's**, from the config, never the row's: it
 * scopes which S3 object the row may point at, so it must come from the
 * partition the caller asked for. A row that names an object outside that scope
 * is refused by the codec rather than downloaded. `signal` — cancels the
 * download an offloaded payload costs.
 *
 * Returns: the checkpoint.
 *
 * Throws: `PAYLOAD_CORRUPT` for bytes that cannot be decoded, `VALIDATION`
 * for a descriptor pointing outside the row's scope and for a payload the
 * configured serde refuses to reconstruct, and whatever the download throws.
 */
export async function readCheckpoint(
  context: CheckpointerContext,
  item: CheckpointPayloadItem,
  threadId: string,
  signal?: AbortSignal,
): Promise<Checkpoint> {
  return decodePayload<Checkpoint>(item.checkpoint, codecDeps(context, signal), [threadId]);
}

/**
 * Decode the metadata stored in a META item.
 *
 * Accepts: as {@link readCheckpoint}, for the metadata blob instead of the
 * checkpoint.
 *
 * Returns: the metadata.
 *
 * Throws: as {@link readCheckpoint}.
 */
export async function readMetadata(
  context: CheckpointerContext,
  item: CheckpointMetaItem,
  threadId: string,
  signal?: AbortSignal,
): Promise<CheckpointMetadata> {
  return decodePayload<CheckpointMetadata>(item.metadata, codecDeps(context, signal), [threadId]);
}

/**
 * Decode WRITE items into `[taskId, channel, value]` pending-write tuples.
 *
 * Accepts: `items` — one checkpoint's WRITE rows, in any order; empty is empty.
 * `threadId` — the caller's, as in {@link readCheckpoint}. `signal` — cancels
 * the downloads, all of which share it.
 *
 * Returns: the writes LangGraph replays, first-write-wins already resolved by
 * `dropSupersededWrites`, in the order the surviving rows were read.
 *
 * Throws: whatever a decode throws — the first one, with the rest allowed to
 * settle.
 *
 * Guarantees: payloads decode several at a time, so a checkpoint with many
 * offloaded writes costs one round of downloads rather than one per write.
 */
export async function toPendingWrites(
  context: CheckpointerContext,
  items: CheckpointWriteItem[],
  threadId: string,
  signal?: AbortSignal,
): Promise<CheckpointPendingWrite[]> {
  const deps = codecDeps(context, signal);
  const live = dropSupersededWrites(items);
  const values = await mapWithConcurrency(
    live,
    context.readConcurrency ?? DEFAULT_READ_CONCURRENCY,
    (item) => decodePayload(item.value, deps, [threadId]),
  );
  return live.map((item, index): CheckpointPendingWrite => [
    item.taskId,
    item.channel,
    values[index],
  ]);
}
