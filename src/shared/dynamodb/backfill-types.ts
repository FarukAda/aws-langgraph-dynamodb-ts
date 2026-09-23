import type { DynamoDBDocumentLike } from './client';
import type { RetryOptions } from './retry';

/** What one pass of the backfill did, and where to resume. */
export interface BackfillResult {
  /** Rows the scan evaluated. */
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

/**
 * What the backfill needs to walk a table.
 *
 * Split out of `backfill-index.ts` so `backfill-validation.ts` can build a
 * compiler-verified key list against it (`allKeysOf<BackfillOptions>`)
 * without that module and `backfill-index.ts` importing each other.
 */
export interface BackfillOptions {
  client: DynamoDBDocumentLike;
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
  /**
   * The full retry surface, not the adapters' narrower `RetryPolicy`:
   * `onRetry` is backfill's only way to observe retries in progress, since it
   * takes no `logger`.
   */
  retry?: RetryOptions;
  signal?: AbortSignal;
}
