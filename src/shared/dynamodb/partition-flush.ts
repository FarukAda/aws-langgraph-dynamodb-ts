import { collectS3Keys, type DescriptorRef } from '../codec/descriptor-keys';
import type { S3Offloader } from '../codec/s3/offloader';
import { cleanUpS3Orphans } from '../codec/s3/orphans';
import { mapWithConcurrency } from '../concurrency';
import { DELETE_CONCURRENCY } from '../constants';
import type { Logger } from '../logging/logger';
import { truncateForLog } from '../logging/truncate';
import type { DynamoDBDocumentLike, DocItem } from './client';
import { isConditionalCheckFailed, rejectedItem, type RevisionGuard } from './conditional-put';
import { withDynamoDBRetry, type RetryOptions } from './retry';

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
 * the options interface itself, so the seam between the two modules stays as
 * small as what crosses it.
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
    await cleanUpS3Orphans(
      deps.offloader,
      collectS3Keys(tally.released),
      deps.operation,
      deps.logger,
      { scope: deps.scope },
    );
  }
  return tally;
}
