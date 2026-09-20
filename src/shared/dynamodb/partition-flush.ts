import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import { collectS3Keys, type DescriptorRef } from '../codec/descriptor-keys';
import type { S3Offloader } from '../codec/s3/offloader';
import { cleanUpS3Orphans } from '../codec/s3/orphans';
import { mapWithConcurrency } from '../concurrency';
import { DELETE_CONCURRENCY } from '../constants';
import type { Logger } from '../logging/logger';
import { isConditionalCheckFailed, rejectedItem, type RevisionGuard } from './conditional-put';
import { withDynamoDBRetry, type RetryOptions } from './retry';
import type { DocItem } from './types';

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
  client: DynamoDBDocument;
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

/** Record a row the pin turned away: left in place, nothing released, reported. */
function recordRefusal(deps: FlushDeps, row: PendingDelete, tally: FlushTally): void {
  tally.refused += 1;
  if (row.unit !== undefined) tally.refusedUnits.push(row.unit);
  deps.logger.warn(`${deps.operation}: left a row rewritten since the read`, {
    sortKey: row.key.SK as string,
  });
}

/**
 * Delete one row, turning a lost pin into an outcome rather than a rejection.
 *
 * A rejection carrying the row means it was rewritten after the read: the row
 * stays, its objects stay, and the pass reports it. A rejection carrying no row
 * means it is already gone — a racing delete, or this pass's own earlier
 * attempt whose acknowledgement was lost — which is the outcome the caller
 * asked for, so it counts as deleted and its objects are released. Anything
 * else is a genuine failure: it is recorded and rethrown, so the pass ends as
 * it does today rather than reporting a delete it did not make.
 */
async function deleteRow(deps: FlushDeps, row: PendingDelete, tally: FlushTally): Promise<void> {
  try {
    await withDynamoDBRetry(
      () =>
        deps.client.delete({
          TableName: deps.tableName,
          Key: row.key,
          ...row.guard,
        }),
      deps.retry,
    );
  } catch (error) {
    const rejection = error as Error;
    if (!isConditionalCheckFailed(rejection)) {
      tally.failures.push(rejection);
      throw rejection;
    }
    if (rejectedItem(rejection) !== undefined) {
      recordRefusal(deps, row, tally);
      return;
    }
  }
  tally.deleted += 1;
  tally.released.push(...row.descriptors);
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
 * Throws: nothing. A genuine failure stops the flush from starting further rows
 * and is handed back in `failures` for the caller to end the pass with; a
 * refusal never stops anything. S3 cleanup never throws either
 * ({@link cleanUpS3Orphans}).
 *
 * Guarantees: at most {@link DELETE_CONCURRENCY} requests are in flight. There
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
    /** Every genuine failure is already in `tally.failures`; the throw only ends the flush. */
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
