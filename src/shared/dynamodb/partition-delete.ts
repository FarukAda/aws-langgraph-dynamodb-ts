/**
 * Hides deleting exactly the rows of a partition that a read observed.
 *
 * A partition on a shared table can hold another adapter's rows, and a row can
 * be rewritten between the read and the delete. A foreign row is left in place,
 * each delete is pinned to the write id the read saw so a rewritten row
 * survives, the rows of a unit are skipped once one of them is refused, and an
 * object is released only once the row naming it is confirmed gone.
 */

import type { QueryCommandInput } from '@aws-sdk/lib-dynamodb';

import { type PayloadDescriptor, collectS3Keys, type DescriptorRef } from '../codec/codec';
import { type S3Offloader, cleanUpS3Orphans } from '../codec/s3/offloader';
import { mapWithConcurrency } from '../concurrency';
import { BATCH_WRITE_MAX, DELETE_CONCURRENCY } from '../constants';
import { batchWriteAllIncompleteError } from '../errors/errors';
import type { Logger } from '../logging/logger';
import { truncateForLog } from '../logging/truncate';
import { isAbortError } from './abort';
import type { DynamoDBDocumentLike, DocItem } from './client';
import {
  type RevisionGuard,
  WRITE_ID_ATTRIBUTE,
  writeIdGuard,
  isConditionalCheckFailed,
  rejectedItem,
} from './idempotent-write';
import { paginateQuery } from './paginate';
import { withDynamoDBRetry, type RetryOptions } from './retry';
import { rowKeyOf } from './table-schema';

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
  /** Aborting it stops the read between pages and rejects with an `ABORTED` error. */
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
    key: rowKeyOf(row),
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
 * Throws: `ABORTED` when the signal fires, whether between pages or during
 * a row's delete, unwrapped and with no further row issued — a cancel is not a
 * delete that half-landed. Otherwise `BATCH_WRITE_INCOMPLETE` when
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

/** One row a pass has read and means to delete. */
export interface PendingDelete {
  key: DocItem;
  /** The pin the read's observation supports; absent for a row that carried no id. */
  guard?: RevisionGuard;
  /** The objects this row names, released only if the row is confirmed gone. */
  descriptors: DescriptorRef[];
  /** The logical unit the row belongs to, when the caller names one. */
  unit?: string;
}

/**
 * What one flush needs, narrowed from the caller's options rather than taking
 * the options interface itself, so the seam between the pass and its flush
 * stays as small as what crosses it.
 */
export interface FlushDeps {
  client: DynamoDBDocumentLike;
  tableName: string;
  logger: Logger;
  /** Names the pass in every log line, e.g. `deleteThread`. */
  operation: string;
  /** The partition's own leading S3 key parts; an object outside them is never deleted. */
  scope: readonly string[];
  /** The adapter's retry options, which already carry the caller's abort signal. */
  retry?: RetryOptions;
  offloader?: S3Offloader;
}

/** What one flush settled, folded into the pass's running totals by its caller. */
export interface FlushTally {
  deleted: number;
  refused: number;
  /** The units of the refused rows, so a later row of the same unit can be skipped. */
  refusedUnits: string[];
  failures: Error[];
  /** The descriptors of the rows confirmed gone, and only those. */
  released: DescriptorRef[];
}

/**
 * Record a row the pin turned away: left in place, nothing released, reported.
 *
 * Reported *before* it is counted, deliberately. The report calls the caller's
 * own `Logger`, and a `Logger` that throws makes this row's handling
 * incomplete; {@link deleteRow} then files it as a failure. Counting it first
 * would leave the same row counted as a refusal the pass also reports as a
 * failure. One row, one outcome.
 */
function recordRefusal(deps: FlushDeps, row: PendingDelete, tally: FlushTally): void {
  deps.logger.warn(`${deps.operation}: left a row rewritten since the read`, {
    sortKey: truncateForLog(row.key.SK as string),
  });
  tally.refused += 1;
  if (row.unit !== undefined) tally.refusedUnits.push(row.unit);
}

/**
 * Settle one row, turning a lost pin into an outcome rather than a rejection.
 *
 * A rejection carrying the row means it was rewritten after the read: the row
 * stays, its objects stay, and the pass reports it. A rejection carrying no row
 * means it is already gone — a racing delete, or this pass's own earlier
 * attempt whose acknowledgement was lost — which is the outcome the caller
 * asked for, so it counts as deleted and its objects are released. Anything
 * else is a genuine failure and is rethrown, so the pass ends rather than
 * reporting a delete it did not make.
 */
async function settleRow(deps: FlushDeps, row: PendingDelete, tally: FlushTally): Promise<void> {
  try {
    await withDynamoDBRetry(
      (request) =>
        deps.client.delete(
          {
            TableName: deps.tableName,
            Key: row.key,
            ...row.guard,
          },
          request,
        ),
      deps.retry,
    );
  } catch (error) {
    const rejection = error as Error;
    if (!isConditionalCheckFailed(rejection)) throw rejection;
    if (rejectedItem(rejection) !== undefined) {
      recordRefusal(deps, row, tally);
      return;
    }
  }
  tally.deleted += 1;
  tally.released.push(...row.descriptors);
}

/**
 * Delete one row, recording whatever stops it before letting the flush end.
 *
 * The recording wraps the whole of {@link settleRow} rather than sitting in the
 * one branch that first needed it, because the delete's own rejection is not
 * the only thing in there that can throw. Reading the row a rejection carries
 * is a decode, and it fails on an `Item` that arrives already unmarshalled —
 * which the stock document client does not produce, but a client wrapped
 * through the documented injection seam can. Reporting a refusal is a call into
 * the caller's own `Logger`, which is consumer code. Neither used to reach
 * `tally.failures`, and an empty `failures` is exactly what the pass reads as
 * "nothing went wrong": one such throw abandoned the rest of the buffer and the
 * pass still resolved, reporting a thread deleted that was mostly still there.
 */
async function deleteRow(deps: FlushDeps, row: PendingDelete, tally: FlushTally): Promise<void> {
  try {
    await settleRow(deps, row, tally);
  } catch (error) {
    tally.failures.push(error as Error);
    throw error;
  }
}

/**
 * Delete a buffer of rows, each pinned on what the read observed of it, then
 * release the objects of the rows that are confirmed gone.
 *
 * Accepts: `deps` — the client, the table, and the logging, retry and offload
 * collaborators of the pass this flush belongs to. `rows` — the buffer,
 * each row carrying its key, its pin and the objects it names.
 *
 * Returns: the tally — rows deleted, rows refused and the units they belonged
 * to, the failures, and the descriptors released.
 *
 * Throws: nothing. Every failure stops the flush from starting further rows and
 * is handed back in `failures` for the caller to end the pass with — the
 * delete's own rejection, and equally a throw from decoding a rejection's
 * attached row or from the caller's logger, neither of which is this pass's to
 * absorb. A refusal never stops anything. S3 cleanup never throws either
 * ({@link cleanUpS3Orphans}).
 *
 * Guarantees: an empty `failures` means every row of the buffer was settled.
 * The flush cannot both lose a failure and hand back a clean tally, which is
 * what let a pass log a deleted thread over a partition it had mostly left
 * alone. At most {@link DELETE_CONCURRENCY} requests are in flight. There
 * is one request per row - that is the price of a condition, which a batch
 * write silently ignores - but they cost a bounded number of sequential rounds
 * rather than one per row, and a partition of any size cannot open a socket
 * per row. A row the pin
 * turned away is left exactly as the racing writer left it, and nothing it
 * names is released — a live row still names those objects.
 */
export async function flushPendingDeletes(
  deps: FlushDeps,
  rows: readonly PendingDelete[],
): Promise<FlushTally> {
  const tally: FlushTally = {
    deleted: 0,
    refused: 0,
    refusedUnits: [],
    failures: [],
    released: [],
  };
  try {
    await mapWithConcurrency(rows, DELETE_CONCURRENCY, (row) => deleteRow(deps, row, tally));
  } catch {
    /**
     * The only thing that reaches here is {@link deleteRow}'s own rethrow, and
     * it records every failure it rethrows — the delete's rejection, the decode
     * of a rejection's attached row, and the caller's logger alike. So what is
     * dropped here is a second reference to something already in
     * `tally.failures`, never the only record of it, and the throw's remaining
     * job was to stop further rows from being started.
     */
  }
  if (deps.offloader) {
    await cleanUpS3Orphans(deps.offloader, {
      keys: collectS3Keys(tally.released),
      operation: deps.operation,
      logger: deps.logger,
      scope: deps.scope,
    });
  }
  return tally;
}
