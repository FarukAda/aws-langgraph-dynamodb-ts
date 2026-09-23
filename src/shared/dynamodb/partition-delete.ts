import type { QueryCommandInput } from '@aws-sdk/lib-dynamodb';

import type { PayloadDescriptor } from '../codec/codec';
import type { S3Offloader } from '../codec/s3/offloader';
import { BATCH_WRITE_MAX } from '../constants';
import { batchWriteAllIncompleteError } from '../errors/errors';
import type { Logger } from '../logging/logger';
import { truncateForLog } from '../logging/truncate';
import { isAbortError } from './abort';
import type { DynamoDBDocumentLike } from './client-types';
import { type RevisionGuard, WRITE_ID_ATTRIBUTE, writeIdGuard } from './conditional-put';
import { paginateQuery } from './paginate';
import { flushPendingDeletes, type PendingDelete } from './partition-flush';
import type { RetryOptions } from './retry';
import type { DocItem } from './types';

/**
 * One offloaded payload a row references, named by the attribute holding it.
 * The name is not decoration: the row is pinned through a document path over
 * that attribute, and a refused row's objects must stay where they are.
 */
export interface NamedDescriptor {
  attribute: string;
  descriptor: PayloadDescriptor;
}

/**
 * One row attribute read as a named descriptor, which is the only way this
 * library fills a {@link NamedDescriptor}.
 *
 * Accepts: `row` — a row the partition read returned, whose attributes this
 * library did not necessarily write. `attribute` — the name the payload would
 * be held under.
 *
 * Returns: the named descriptor, or nothing when the row carries no usable one
 * there. An absent attribute and one holding `null` are the same answer,
 * because neither names a payload: the row contributes no id to pin on and no
 * object to release. Narrowing here rather than at each caller is what keeps
 * `descriptor` the non-null thing the type claims — a `null` cast into the
 * array by a caller reached `pinFor`, which reads a write id off it.
 *
 * Throws: nothing.
 */
export function namedDescriptor(row: DocItem, attribute: string): NamedDescriptor | undefined {
  const descriptor = row[attribute] as PayloadDescriptor | null | undefined;
  if (descriptor === null || descriptor === undefined) return undefined;
  return { attribute, descriptor };
}

/** Collaborators and per-adapter policy for one partition-wide delete. */
export interface PartitionDeleteOptions {
  client: DynamoDBDocumentLike;
  tableName: string;
  params: QueryCommandInput;
  logger: Logger;
  /** The adapter's retry options for the page reads and the row deletes. */
  retry?: RetryOptions;
  /** Aborting it stops the read between pages and rejects with the library's AbortError. */
  signal?: AbortSignal;
  offloader?: S3Offloader;
  /** Label for log lines and S3-cleanup diagnostics, e.g. `deleteThread`. */
  operation: string;
  /**
   * True when a sort key belongs to the calling adapter. A partition query
   * carries no sort-key condition, so without this a shared-table partition
   * holding a foreign row would have that row deleted too.
   */
  ownsSortKey: (sortKey: string) => boolean;
  /**
   * The offloaded payload descriptors a row references, each named by its
   * attribute, and each read off the row with {@link namedDescriptor} so that
   * an attribute holding `null` yields no entry rather than an unusable one.
   */
  descriptorsOf: (row: DocItem) => NamedDescriptor[];
  /**
   * Top-level attribute carrying a row's per-write id, for the row kinds that
   * have one. Preferred over a descriptor's own id where it exists: it needs no
   * document path, and it is the same attribute the writer already pins on.
   */
  idAttribute?: string;
  /**
   * The logical unit a row belongs to. A unit's rows are written together but
   * deleted one by one, so a refusal on an earlier one has to suppress the
   * rest; an adapter whose rows form no unit supplies nothing.
   */
  unitOf?: (row: DocItem) => string;
  /**
   * The row kind bounding a flush. Rows arrive kind by kind, so flushing when
   * the kind changes is what settles a refusal before the rows it must suppress
   * are issued.
   */
  kindOf?: (row: DocItem) => string;
  /** The partition's own leading S3 key parts; objects outside their path are never deleted. */
  scope: readonly string[];
}

/**
 * Everything one pass carries between flushes. The totals run across every
 * flush: a streamed delete issues many independent requests, and without
 * carrying them forward a mid-stream failure would report only the failing
 * flush's counts and understate how much was actually deleted. `units` is the
 * carry-forward itself, and holds the ids of refused units rather than rows, so
 * its size is bounded by refusals and not by partition size.
 */
interface PassState {
  buffer: PendingDelete[];
  deleted: number;
  attempted: number;
  skipped: number;
  units: Set<string>;
}

/**
 * The condition the read's own observation supports: the top-level id when the
 * row carries one, else the id on the first descriptor that has one. A row
 * observed with neither gets none and is deleted unconditionally — every row
 * written before the id existed is such a row, and refusing those would leave a
 * table upgraded in place impossible to empty.
 */
function pinFor(
  idAttribute: string | undefined,
  row: DocItem,
  named: readonly NamedDescriptor[],
): RevisionGuard | undefined {
  if (idAttribute !== undefined) {
    const observed = row[idAttribute];
    if (typeof observed === 'string') return writeIdGuard(idAttribute, observed);
  }
  for (const entry of named) {
    const { writeId } = entry.descriptor;
    if (writeId !== undefined) return writeIdGuard(entry.attribute, writeId, WRITE_ID_ATTRIBUTE);
  }
  return undefined;
}

/** The row as a buffered delete: its key, its pin, its objects and its unit. */
function pendingDelete(options: PartitionDeleteOptions, row: DocItem): PendingDelete {
  const named = options.descriptorsOf(row);
  return {
    key: { PK: row.PK as string, SK: row.SK as string },
    guard: pinFor(options.idAttribute, row, named),
    descriptors: named.map((entry) => entry.descriptor),
    unit: options.unitOf?.(row),
  };
}

/** Whether an earlier kind's refusal already settled this row's unit. */
function unitRefused(options: PartitionDeleteOptions, row: DocItem, state: PassState): boolean {
  const unit = options.unitOf?.(row);
  return unit !== undefined && state.units.has(unit);
}

/**
 * The cancel among a flush's failures, when the caller's signal fired. A row
 * whose delete was cancelled is neither deleted nor failed, so reporting the
 * pass as an incomplete delete told a caller branching on `ABORTED` that its
 * own stop was a fault.
 */
function cancelAmong(failures: readonly Error[]): Error | undefined {
  return failures.find(isAbortError);
}

/** Delete the buffered rows, fold what they settled into the pass, and empty the buffer. */
async function flushBuffer(options: PartitionDeleteOptions, state: PassState): Promise<void> {
  if (state.buffer.length === 0) return;
  const tally = await flushPendingDeletes(options, state.buffer.splice(0));
  state.deleted += tally.deleted;
  state.skipped += tally.refused;
  /**
   * Refusals are deliberately out of this total. They are not rows the pass
   * failed to delete; they are rows it was never entitled to delete, already
   * counted as `skipped` and reported on their own line. Counting them here
   * would make the error read `1/3 row(s) succeeded, 1 row(s) failed` and leave
   * the reader to guess at the third.
   */
  state.attempted += tally.deleted + tally.failures.length;
  for (const unit of tally.refusedUnits) state.units.add(unit);
  if (tally.failures.length === 0) return;
  const cancelled = cancelAmong(tally.failures);
  if (cancelled !== undefined) throw cancelled;
  const { deleted, attempted } = state;
  throw batchWriteAllIncompleteError(deleted, attempted, tally.failures, deleted, 'row');
}

/**
 * Delete exactly the rows of one partition that this adapter's read observed.
 *
 * Accepts: `params` — the partition query, which carries no sort-key
 * condition. `ownsSortKey` — decides per row; a row it rejects is left in
 * place and reported at `warn`, which is what keeps a shared table's other
 * adapters intact. `descriptorsOf` — the offloaded payloads a row references,
 * each named by the attribute holding it. `idAttribute`, `unitOf` and `kindOf`
 * — the per-write id, the unit and the kind boundary, for an adapter whose
 * rows have them. `scope` — the partition's own leading S3 key parts; an object
 * outside their path is never deleted. `signal` — stops the read between pages.
 *
 * Returns: how many rows were deleted, not counting the ones left in place.
 *
 * Throws: `AbortError` when the signal fires, whether between pages or during
 * a row's delete, unwrapped and with no further row issued — a cancel is not a
 * delete that half-landed. Otherwise {@link BatchWriteAllIncompleteError} when
 * a row's delete fails, carrying what did succeed across every earlier flush.
 * S3 cleanup never throws, whatever it finds.
 *
 * Guarantees: every delete is pinned on the per-write id the read observed, so
 * a row rewritten after that read is left in place and reported rather than
 * erased with the object it names. A row observed carrying no id is deleted
 * unconditionally, as it was before the pin existed. The read is deliberately
 * uncapped (`maxItems` and `maxIterations` are `Infinity`), so a partition of
 * any size is deleted to completion rather than truncated at the in-memory page
 * caps — memory stays bounded because rows are flushed in batches of
 * {@link BATCH_WRITE_MAX} and never accumulated. The carry-forward depends on
 * the scan being **ascending**, which is the default the partition queries rely
 * on: a kind's rows are settled before the next kind's are issued, so a refusal
 * suppresses the rest of its unit. A failure part-way keeps the rows already
 * deleted; this is a single pass over a quiescent partition, not a transaction.
 */
export async function deletePartitionRows(options: PartitionDeleteOptions): Promise<number> {
  const state: PassState = { buffer: [], deleted: 0, attempted: 0, skipped: 0, units: new Set() };
  let kind: string | undefined;
  const pages = paginateQuery({
    client: options.client,
    params: options.params,
    retry: options.retry,
    signal: options.signal,
    maxItems: Number.POSITIVE_INFINITY,
    maxIterations: Number.POSITIVE_INFINITY,
  });
  for await (const row of pages) {
    const sortKey = row.SK as string;
    if (!options.ownsSortKey(sortKey)) {
      state.skipped += 1;
      options.logger.warn(`${options.operation}: left a foreign row in place`, {
        sortKey: truncateForLog(sortKey),
      });
      continue;
    }
    const rowKind = options.kindOf?.(row);
    if (rowKind !== kind) {
      await flushBuffer(options, state);
      kind = rowKind;
    }
    if (unitRefused(options, row, state)) {
      state.skipped += 1;
      options.logger.warn(`${options.operation}: skipped a row whose unit was refused`, {
        sortKey: truncateForLog(sortKey),
      });
      continue;
    }
    state.buffer.push(pendingDelete(options, row));
    if (state.buffer.length >= BATCH_WRITE_MAX) await flushBuffer(options, state);
  }
  await flushBuffer(options, state);
  const { deleted, skipped } = state;
  options.logger.info(`${options.operation}: deleted rows`, { deleted, skipped });
  return deleted;
}
