import { mapWithConcurrency } from '../concurrency';
import { DEFAULT_READ_CONCURRENCY } from '../constants';
import { guardPublic } from '../errors/boundary';
import { decodeScanCursor, encodeScanCursor, indexTargetOf } from './backfill-target';
import type { BackfillOptions, BackfillResult } from './backfill-types';
import { validateBackfillOptions } from './backfill-validation';
import { DEFAULT_INDEX_SHARDS, indexKeys } from './index-keys';
import { type RetryOptions, withDynamoDBRetry } from './retry';
import type { DocItem } from './types';

/**
 * The retry policy every request of one run uses: the caller's `retry`, with
 * the signal that cancels the run. That is the top-level `signal` when one is
 * given and `retry.signal` otherwise — the top-level one is the caller's handle
 * on the whole operation, so it wins when both are set.
 */
function runRetry(options: BackfillOptions): RetryOptions {
  return { ...options.retry, signal: options.signal ?? options.retry?.signal };
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
    runRetry(options),
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
    runRetry(options),
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
 * Accepts: `options` — validated in full before any read: only the keys
 * `BackfillOptions` declares; `tableName`, `indexShards` and the numbers in
 * `retry` by the adapters' rules; `signal` as their methods check it; a
 * `client` providing `scan` and `update`. `options.pageSize` — a positive integer,
 * default 100. `options.cursor` — from a previous run, to resume.
 * `options.maxPages` — how far one run goes, so a large table can be
 * backfilled in bounded slices. `options.indexShards` — must equal the
 * adapters' setting, and has their ceiling. `options.dryRun` — a boolean.
 * `options.signal` — cancels the run; `retry.signal` does so when there is no
 * top-level `signal`, and the top-level one wins when both are given.
 *
 * Returns: how many rows were scanned and how many were given keys, plus a
 * `nextCursor` when the run stopped short of the end. An absent cursor means
 * the table is fully backfilled.
 *
 * Throws: ValidationError naming the offending option, before any DynamoDB
 * call; RetryExhaustedError once a transient failure has used every attempt;
 * AbortError when `signal` fires, or `retry.signal` when no top-level `signal`
 * is given; UpstreamError wrapping any other error the scan or the writes
 * throw — this is the function's own error boundary, the same as every
 * adapter's public methods, so a caller's mistake never escapes as a bare
 * exception.
 *
 * Guarantees: every write is conditional on the row having no keys yet, so
 * re-running is safe, running against a live table is safe, and a row a live
 * adapter has already indexed is left exactly as it is.
 */
export async function backfillRecencyIndex(options: BackfillOptions): Promise<BackfillResult> {
  return guardPublic('backfillRecencyIndex', async () => {
    validateBackfillOptions(options);
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
  });
}
