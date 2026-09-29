/**
 * Hides how rows written before the recency index are given its keys.
 *
 * The index is opt-in (record 8), so a table can hold rows from before it
 * existed. An operator walks the table a page at a time, resumably, and gives
 * each row the keys its adapter would have written; which rows those are is
 * each adapter's own answer, asked here, and a row that gained keys since the
 * scan read it is left alone.
 */

import { checkpointIndexTarget } from '../checkpointer/internal/rows.js';
import { sessionIndexTarget } from '../history/internal/session.js';
import { DEFAULT_READ_CONCURRENCY, mapWithConcurrency } from '../shared/concurrency.js';
import type { AttributeMap, DynamoDBDocumentLike } from '../shared/dynamodb/client.js';
import { isConditionalCheckFailed } from '../shared/dynamodb/idempotent-write.js';
import {
  DEFAULT_INDEX_SHARDS,
  type IndexKeys,
  indexKeys,
  type IndexTarget,
  MAX_INDEX_SHARDS,
} from '../shared/dynamodb/recency-index.js';
import { type RetryOptions, withDynamoDBRetry } from '../shared/dynamodb/retry.js';
import { PARTITION_KEY_ATTRIBUTE, rowKeyOf } from '../shared/dynamodb/table-schema.js';
import { guardPublic } from '../shared/errors/boundary.js';
import { validationError } from '../shared/errors/errors.js';
import {
  assertClientTranslation,
  assertMembers,
  assertSignalLike,
} from '../shared/validation/collaborators.js';
import { allKeysOf, assertShape } from '../shared/validation/option-shape.js';
import { assertRetryBounds, assertTableName } from '../shared/validation/options.js';
import { assertInteger, assertStringArray } from '../shared/validation/primitives.js';

/**
 * The retry policy every request of one run uses: the caller's `retry`, with
 * the signal that cancels the run. That is the top-level `signal` when one is
 * given and `retry.signal` otherwise — the top-level one is the caller's handle
 * on the whole operation, so it wins when both are set.
 */
function runRetry(options: BackfillOptions): RetryOptions {
  return { ...options.retry, signal: options.signal ?? options.retry?.signal };
}

/**
 * Write one row's index keys; false when this run wrote none for it.
 *
 * False is an ordinary outcome and never a failure. Either the row is not one a
 * listing reaches, so it needs no keys; or the conditional update was refused,
 * which by the terms of that condition means the row already carries keys a
 * live adapter gave it, or the row is gone. In every one of those cases this
 * run has nothing to do for the row, and the row is counted as skipped.
 *
 * Which is why the refusal ends the row rather than the run. Both races are
 * ordinary on a table that is being written to, and that is the only kind of
 * table anyone runs a backfill against; a tool that stopped whenever the table
 * it is migrating is in use would never finish one. Re-running is cheap and
 * safe besides — the scan's own `attribute_not_exists` filter never looks at a
 * row an earlier run indexed.
 *
 * Any other failure is rethrown and ends the run, because nothing about it says
 * this row needed no writing.
 */
async function indexRow(
  options: BackfillOptions,
  row: AttributeMap,
  shards: number,
): Promise<boolean> {
  const target = indexTargetOf(row);
  if (target === undefined) return false;
  const keys = indexKeys(target.tag, target.id, target.at, shards);
  if (options.dryRun) return true;
  try {
    await writeIndexKeys(options, row, keys);
  } catch (error) {
    if (!isConditionalCheckFailed(error as Error)) throw error;
    return false;
  }
  return true;
}

/** The conditional `UpdateItem` that gives one row the keys computed for it. */
async function writeIndexKeys(
  options: BackfillOptions,
  row: AttributeMap,
  keys: IndexKeys,
): Promise<void> {
  await withDynamoDBRetry(
    (request) =>
      options.client.update(
        {
          TableName: options.tableName,
          Key: rowKeyOf(row),
          UpdateExpression: 'SET #gpk = :gpk, #gsk = :gsk',
          ExpressionAttributeNames: { '#gpk': 'gsi1pk', '#gsk': 'gsi1sk' },
          ExpressionAttributeValues: { ':gpk': keys.gsi1pk, ':gsk': keys.gsi1sk },
          // Two clauses, and both are load-bearing.
          //
          // `attribute_not_exists(#gpk)` never overwrites keys a row already has:
          // a row a running adapter wrote carries its true timestamp, and
          // replacing it with the pre-index epoch would move a live row to the
          // bottom of every listing.
          //
          // `attribute_exists(PK)` is what makes this an update rather than an
          // upsert, which is what `UpdateItem` is by default. A condition naming
          // only the index attribute is satisfied by a key holding *nothing at
          // all*, so without it, a row deleted between the scan that found it
          // and this update would be re-created as a stub carrying nothing but
          // `PK`, `SK` and the two index keys — and carrying them, it would land
          // in the recency index that the cross-partition listings read. The
          // tool exists to give keys to rows that are already there, so nothing
          // legitimate is refused.
          ConditionExpression: `attribute_exists(${PARTITION_KEY_ATTRIBUTE}) AND attribute_not_exists(#gpk)`,
        },
        request,
      ),
    runRetry(options),
  );
}

/** One scan page, and the rows of it that were given keys. */
async function backfillPage(
  options: BackfillOptions,
  shards: number,
  startKey: AttributeMap | undefined,
): Promise<{ rows: number; indexed: number; nextKey: AttributeMap | undefined }> {
  const result = await withDynamoDBRetry(
    (request) =>
      options.client.scan(
        {
          TableName: options.tableName,
          Limit: options.pageSize ?? 100,
          ExclusiveStartKey: startKey,
          // Rows that already carry keys are not read into memory at all.
          FilterExpression: 'attribute_not_exists(#gpk)',
          ExpressionAttributeNames: { '#gpk': 'gsi1pk' },
        },
        request,
      ),
    runRetry(options),
  );
  const rows = (result.Items ?? []) as AttributeMap[];
  const written = await mapWithConcurrency(rows, DEFAULT_READ_CONCURRENCY, (row) =>
    indexRow(options, row, shards),
  );
  return {
    rows: rows.length,
    indexed: written.filter(Boolean).length,
    nextKey: result.LastEvaluatedKey as AttributeMap | undefined,
  };
}

/**
 * Give rows written before the recency index their index keys.
 *
 * **Run this before setting `indexName` on any adapter.** A row without the
 * keys is not in the index, so enabling the index first would make every
 * pre-existing session and checkpoint silently vanish from the listings
 * that read it — the rows are still there, and every other read still returns
 * them, but a listing would not.
 *
 * Safe to re-run and safe to run while adapters are writing: every write is
 * conditional on the row still being there and having no keys yet, so a row a
 * live adapter has already indexed is left exactly as it is, and a row deleted
 * after the scan found it stays deleted rather than being re-created by an
 * `UpdateItem`, which upserts.
 *
 * `indexShards` must match what the saver and the history use. A mismatch
 * puts rows on shards no listing queries, which looks exactly like the rows
 * being missing.
 *
 * Accepts: `options` — validated in full before any read: only the keys
 * `BackfillOptions` declares; `tableName`, `indexShards` and the numbers in
 * `retry` by the adapters' rules; `signal` as their methods check it; a
 * `client` providing `scan` and `update`. `options.pageSize` — a positive integer,
 * default 100. `options.cursor` — from a previous run, to resume.
 * `options.maxPages` — how far one run goes, so a large table can be
 * backfilled in bounded slices. `options.indexShards` — must equal the
 * saver's and the history's setting, and has their ceiling. `options.dryRun` — a boolean.
 * `options.signal` — cancels the run; `retry.signal` does so when there is no
 * top-level `signal`, and the top-level one wins when both are given.
 *
 * Returns: how many rows were scanned, how many were given keys and how many
 * were skipped — a row no listing reaches, and a row whose write the condition
 * refused because the row already has keys or is gone — plus a `nextCursor`
 * when the run stopped short of the end. An absent cursor means the table is
 * fully backfilled.
 *
 * Throws: `VALIDATION` naming the offending option, before any DynamoDB
 * call; `RETRY_EXHAUSTED` once a transient failure has used every attempt;
 * `ABORTED` when `signal` fires, or `retry.signal` when no top-level `signal`
 * is given; any other error the scan or the writes throw, wrapped with the
 * code the classifier assigns — this is the function's own error boundary,
 * the same as every adapter's public methods, so a caller's mistake never escapes as a bare
 * exception. A refused write is none of these: it is an outcome for one row,
 * reported in `skipped`.
 *
 * Guarantees: every write is conditional on the row still being there and
 * having no keys yet, so re-running is safe, running against a live table is
 * safe, a row a live adapter has already indexed is left exactly as it is, and
 * a row deleted between the scan and the write is never re-created. Neither
 * refusal stops the run: both mean this run has nothing to do for that row, so
 * the row is counted as skipped and the walk carries on to the rest of the
 * table.
 */
export async function backfillRecencyIndex(options: BackfillOptions): Promise<BackfillResult> {
  return guardPublic('backfillRecencyIndex', async () => {
    assertBackfillOptions(options);
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

/**
 * Which rows the index covers: the checkpointer and the chat history each
 * answer for their own rows; a store row is in no listing the index serves.
 *
 * Accepts: `row` — any row a table scan returns, including a foreign one and
 * one whose `PK`/`SK` are not strings.
 *
 * Returns: the index identity, or undefined for a row no listing reaches — a
 * foreign row, a payload or write row, a META row carrying no `checkpointId`,
 * or a store row.
 *
 * Throws: nothing. A backfill walks the whole table; one unrecognised row must
 * be skipped, not fatal.
 */
export function indexTargetOf(row: AttributeMap): IndexTarget | undefined {
  return checkpointIndexTarget(row) ?? sessionIndexTarget(row);
}

/**
 * A scan position, as an opaque string.
 *
 * Accepts: `key` — a `LastEvaluatedKey` from the scan being resumed.
 *
 * Returns: it base64url-encoded. Opaque to the caller: its shape is not a
 * promise, which is what leaves the encoding free to change.
 *
 * Throws: nothing.
 */
export function encodeScanCursor(key: AttributeMap): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

/** Whether `value` is exactly the base table's primary key: `PK` and `SK`, both strings, nothing else. */
function isTableKeyShape(value: AttributeMap): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && typeof value.PK === 'string' && typeof value.SK === 'string';
}

/**
 * The scan position a cursor encodes.
 *
 * Accepts: `cursor` — as a previous page returned it.
 *
 * Returns: the `ExclusiveStartKey` to resume from — always exactly `{ PK,
 * SK }`, both strings, since a plain table `Scan` (no `IndexName`) never
 * returns a `LastEvaluatedKey` shaped any other way.
 *
 * Throws: `VALIDATION` naming `cursor` for anything this tool did not
 * issue — text that is not base64url, that does not decode to JSON, or that
 * decodes to anything but `{ PK: string, SK: string }`: an array, an object
 * missing either key, carrying an extra one, or carrying a non-string value
 * for either. A cursor is fed straight back to DynamoDB as
 * `ExclusiveStartKey`, so a value of the wrong shape is refused here rather
 * than surfacing as a raw `ValidationException` from the service.
 */
export function decodeScanCursor(cursor: string): AttributeMap {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as AttributeMap;
    if (!isTableKeyShape(decoded)) throw new Error('not a scan position');
    return decoded;
  } catch {
    throw validationError('cursor is not one this tool issued', 'cursor');
  }
}

/** What one pass of the backfill did, and where to resume. */
export interface BackfillResult {
  /** Rows the scan returned: those without index keys, since its filter drops every row that has them. Not the rows DynamoDB evaluated, which a filter does not reduce. */
  scanned: number;
  /** Rows given index keys. */
  indexed: number;
  /**
   * Rows this run wrote no keys for: one no listing reaches, and one whose
   * write the condition refused because it already has keys or is gone.
   */
  skipped: number;
  /**
   * Opaque; absent when the table is fully walked. Pass it back to continue —
   * the pass is resumable, so a large table can be backfilled in bounded runs.
   */
  nextCursor?: string;
}

/** What the backfill needs to walk a table. A key this type does not declare is refused. */
export interface BackfillOptions {
  client: DynamoDBDocumentLike;
  tableName: string;
  /** Must equal the saver's and the history's `indexShards`, or rows land on shards no listing queries. */
  indexShards?: number;
  /** Rows per scan page. */
  pageSize?: number;
  /** Stop after this many pages and return a cursor. Default: walk the whole table. */
  maxPages?: number;
  cursor?: string;
  /** Report what would change without writing. */
  dryRun?: boolean;
  /**
   * The full retry surface, not the adapters' narrower `RetryPolicy`:
   * `onRetry` is backfill's only way to observe retries in progress, since it
   * takes no `logger`.
   */
  retry?: RetryOptions;
  signal?: AbortSignal;
}

/**
 * The keys of {@link BackfillOptions}, exhaustive in both directions —
 * `allKeysOf<T>` fails to compile if this list omits or invents one.
 */
const BACKFILL_KEYS = allKeysOf<BackfillOptions>({
  client: 'client',
  tableName: 'tableName',
  indexShards: 'indexShards',
  pageSize: 'pageSize',
  maxPages: 'maxPages',
  cursor: 'cursor',
  dryRun: 'dryRun',
  retry: 'retry',
  signal: 'signal',
});

/** The `DynamoDBDocument` methods the backfill calls on an injected `client`. */
const BACKFILL_CLIENT_MEMBERS: readonly string[] = ['scan', 'update'];

/**
 * The keys of {@link RetryOptions}, exhaustive in both directions. Backfill
 * accepts the full retry surface, not the adapters' narrower `RetryPolicy`
 * `assertRetryPolicy` checks — `onRetry` is backfill's only way to observe
 * retries, since it takes no `logger`.
 *
 * `deadlineAt` is the one exclusion: it is an internal per-call bound a write
 * path sets on itself, not something an application names, so it stays an
 * unknown key here and is refused like any other. Excluding it by `Omit`
 * rather than by leaving it out keeps the list exhaustive, so a genuinely new
 * option still fails to compile until it is decided on here.
 */
const BACKFILL_RETRY_KEYS = allKeysOf<Omit<RetryOptions, 'deadlineAt'>>({
  maxAttempts: 'maxAttempts',
  baseDelayMs: 'baseDelayMs',
  maxDelayMs: 'maxDelayMs',
  retryableErrors: 'retryableErrors',
  isRetryable: 'isRetryable',
  onRetry: 'onRetry',
  signal: 'signal',
  rng: 'rng',
});

/**
 * Validate a `backfillRecencyIndex` retry policy against the full
 * {@link RetryOptions} surface.
 *
 * Accepts: `retry` — must be an object naming only {@link BACKFILL_RETRY_KEYS}.
 * `maxAttempts`/`baseDelayMs`/`maxDelayMs` share the adapters' own bounds
 * ({@link assertRetryBounds}), so backfill and the adapters it feeds cannot
 * drift apart on what a legal value is. `retryableErrors`, when given, must be
 * an array of strings. `isRetryable`, `onRetry` and `rng`, when given, must
 * each be a function. `signal` is checked the same way the top-level
 * `options.signal` is. Either one cancels the run; when both are given the
 * top-level one wins, since the caller's own signal is meant to cancel the
 * whole operation.
 *
 * Returns: nothing: the value is kept under its declared type, and this
 * checks it.
 *
 * Throws: `VALIDATION` naming `retry`, `retry.<numeric key>`,
 * `retry.retryableErrors`, `retry.isRetryable`, `retry.onRetry`, `retry.rng`
 * or `retry.signal`.
 */
function assertBackfillRetryOptions(retry: RetryOptions): void {
  assertShape(retry, BACKFILL_RETRY_KEYS, 'retry');
  assertRetryBounds(retry);
  if (retry.retryableErrors !== undefined) {
    assertStringArray(retry.retryableErrors, 'retry.retryableErrors');
  }
  if (retry.isRetryable !== undefined && typeof retry.isRetryable !== 'function') {
    throw validationError('retry.isRetryable must be a function', 'retry.isRetryable');
  }
  if (retry.onRetry !== undefined && typeof retry.onRetry !== 'function') {
    throw validationError('retry.onRetry must be a function', 'retry.onRetry');
  }
  if (retry.rng !== undefined && typeof retry.rng !== 'function') {
    throw validationError('retry.rng must be a function', 'retry.rng');
  }
  assertSignalLike(retry.signal, 'retry.signal');
}

/**
 * Reject a non-integer positive bound, `undefined` left to its own default.
 *
 * Accepts: `value` — `options.pageSize`, `options.maxPages` or
 * `options.indexShards`, as the caller gave it. `field` — what the error
 * names. `max` — an upper bound, when one applies.
 *
 * Returns: nothing: the value is kept under its declared type, and this
 * checks it.
 *
 * Throws: `VALIDATION` naming `field` — including for `null`, which is a
 * caller's explicit (wrong) value, not "unset", so it is refused rather than
 * silently falling through to the default the way `??` alone would.
 */
function assertPositiveBound(value: number | undefined, field: string, max?: number): void {
  if (value === undefined) return;
  assertInteger(value, field, max === undefined ? { min: 1 } : { min: 1, max });
}

/**
 * Validate every option `backfillRecencyIndex` reads, before any of them is
 * read for real.
 *
 * Accepts: `options` — must be an object naming only the nine keys
 * {@link BackfillOptions} declares. `tableName` and `client` are required, the
 * rest optional; each, when given, follows the same rule an adapter's own
 * option of the same name does. `tableName` reuses the adapters' own
 * `tableName` validator outright; `indexShards` is held to the adapters'
 * shard cap, `MAX_INDEX_SHARDS`; and `retry` shares its numeric bounds with
 * the adapters' own `retry` validator while accepting the wider surface
 * backfill's `RetryOptions` needs, so a mismatch between backfill and the
 * adapters it feeds cannot drift in on what a bound means.
 *
 * Returns: nothing: the value is kept under its declared type, and this
 * checks it.
 *
 * Throws: `VALIDATION` naming `options.<key>` for an unknown key;
 * `tableName`; `client` or `client.<member>`; `indexShards`, `pageSize` or
 * `maxPages` for a non-positive-integer bound (`indexShards` is additionally
 * capped); `dryRun` for a non-boolean; `retry`/`retry.<key>`; `signal`.
 */
export function assertBackfillOptions(options: BackfillOptions): void {
  assertShape(options, BACKFILL_KEYS, 'options');
  assertTableName(options.tableName);
  assertMembers(options.client, BACKFILL_CLIENT_MEMBERS, 'client');
  assertClientTranslation(options.client);
  assertPositiveBound(options.indexShards, 'indexShards', MAX_INDEX_SHARDS);
  assertPositiveBound(options.pageSize, 'pageSize');
  assertPositiveBound(options.maxPages, 'maxPages');
  if (options.dryRun !== undefined && typeof options.dryRun !== 'boolean') {
    throw validationError('dryRun must be a boolean', 'dryRun');
  }
  if (options.retry !== undefined) assertBackfillRetryOptions(options.retry);
  assertSignalLike(options.signal);
}
