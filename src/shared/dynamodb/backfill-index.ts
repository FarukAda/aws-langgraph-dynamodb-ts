import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import { mapWithConcurrency } from '../concurrency';
import { DEFAULT_READ_CONCURRENCY } from '../constants';
import { ValidationError } from '../errors/errors';
import { decodeScanCursor, encodeScanCursor, indexTargetOf } from './backfill-target';
import { DEFAULT_INDEX_SHARDS, indexKeys } from './index-keys';
import { withDynamoDBRetry } from './retry';
import type { RetryOptions } from './retry';
import type { DocItem } from './types';

/** What one pass of the backfill did, and where to resume. */
export interface BackfillResult {
  /** Rows the scan evaluated. */
  scanned: number;
  /** Rows given index keys. */
  indexed: number;
  /** Rows no listing reaches, so no keys were written. */
  skipped: number;
  /**
   * Opaque; absent when the table is fully walked. Pass it back to continue —
   * the pass is resumable, so a large table can be backfilled in bounded runs.
   */
  nextCursor?: string;
}

/** What the backfill needs to walk a table. */
export interface BackfillOptions {
  client: DynamoDBDocument;
  tableName: string;
  /** Must equal the adapters' `indexShards`, or rows land on shards no listing queries. */
  indexShards?: number;
  /** Rows per scan page. */
  pageSize?: number;
  /** Stop after this many pages and return a cursor. Default: walk the whole table. */
  maxPages?: number;
  cursor?: string;
  /** Report what would change without writing. */
  dryRun?: boolean;
  retry?: RetryOptions;
  signal?: AbortSignal;
}

/** Write one row's index keys; false when the row is not one a listing reaches. */
async function indexRow(options: BackfillOptions, row: DocItem, shards: number): Promise<boolean> {
  const target = indexTargetOf(row);
  if (target === undefined) return false;
  const keys = indexKeys(target.tag, target.id, target.at, shards);
  if (options.dryRun) return true;
  await withDynamoDBRetry(
    () =>
      options.client.update({
        TableName: options.tableName,
        Key: { PK: row.PK, SK: row.SK },
        UpdateExpression: 'SET #gpk = :gpk, #gsk = :gsk',
        ExpressionAttributeNames: { '#gpk': 'gsi1pk', '#gsk': 'gsi1sk' },
        ExpressionAttributeValues: { ':gpk': keys.gsi1pk, ':gsk': keys.gsi1sk },
        /**
         * Never overwrite keys a row already has: a row a running adapter wrote
         * carries its true timestamp, and replacing it with the pre-index epoch
         * would move a live row to the bottom of every listing.
         */
        ConditionExpression: 'attribute_not_exists(#gpk)',
      }),
    { ...options.retry, signal: options.signal },
  );
  return true;
}

/** One scan page, and the rows of it that were given keys. */
async function backfillPage(
  options: BackfillOptions,
  shards: number,
  startKey: DocItem | undefined,
): Promise<{ rows: number; indexed: number; nextKey: DocItem | undefined }> {
  const result = await withDynamoDBRetry(
    () =>
      options.client.scan({
        TableName: options.tableName,
        Limit: options.pageSize ?? 100,
        ExclusiveStartKey: startKey,
        /** Rows that already carry keys are not read into memory at all. */
        FilterExpression: 'attribute_not_exists(#gpk)',
        ExpressionAttributeNames: { '#gpk': 'gsi1pk' },
      }),
    { ...options.retry, signal: options.signal },
  );
  const rows = (result.Items ?? []) as DocItem[];
  const written = await mapWithConcurrency(rows, DEFAULT_READ_CONCURRENCY, (row) =>
    indexRow(options, row, shards),
  );
  return {
    rows: rows.length,
    indexed: written.filter(Boolean).length,
    nextKey: result.LastEvaluatedKey as DocItem | undefined,
  };
}

/**
 * Give rows written before the recency index their index keys.
 *
 * **Run this before setting `indexName` on any adapter.** A row without the
 * keys is not in the index, so enabling the index first would make every
 * pre-existing session, item and checkpoint silently vanish from the listings
 * that read it — the rows are still there, and every other read still returns
 * them, but a listing would not.
 *
 * Safe to re-run and safe to run while adapters are writing: every write is
 * conditional on the row having no keys yet, so a row a live adapter has
 * already indexed is left exactly as it is.
 *
 * `indexShards` must match what the adapters use. A mismatch puts rows on
 * shards no listing queries, which looks exactly like the rows being missing.
 *
 * Accepts: `options.pageSize` — a positive integer, default 100.
 * `options.cursor` — from a previous run, to resume. `options.maxPages` — how
 * far one run goes, so a large table can be backfilled in bounded slices.
 * `options.indexShards` — must equal the adapters' setting.
 *
 * Returns: how many rows were scanned and how many were given keys, plus a
 * `cursor` when the run stopped short of the end. An absent cursor means the
 * table is fully backfilled.
 *
 * Throws: ValidationError naming `pageSize` or `cursor`; whatever the scan and
 * the writes throw.
 *
 * Guarantees: every write is conditional on the row having no keys yet, so
 * re-running is safe, running against a live table is safe, and a row a live
 * adapter has already indexed is left exactly as it is.
 */
export async function backfillRecencyIndex(options: BackfillOptions): Promise<BackfillResult> {
  const pageSize = options.pageSize ?? 100;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new ValidationError('pageSize must be a positive integer', 'pageSize');
  }
  const shards = options.indexShards ?? DEFAULT_INDEX_SHARDS;
  let startKey = options.cursor === undefined ? undefined : decodeScanCursor(options.cursor);
  let scanned = 0;
  let indexed = 0;
  for (let page = 1; ; page++) {
    const result = await backfillPage(options, shards, startKey);
    scanned += result.rows;
    indexed += result.indexed;
    startKey = result.nextKey;
    if (startKey === undefined) break;
    if (options.maxPages !== undefined && page >= options.maxPages) {
      return {
        scanned,
        indexed,
        skipped: scanned - indexed,
        nextCursor: encodeScanCursor(startKey),
      };
    }
  }
  return { scanned, indexed, skipped: scanned - indexed };
}
