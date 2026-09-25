/**
 * Hides the conventions every row of the shared table follows, whichever
 * adapter wrote it.
 *
 * The three adapters share one table (record 2), so a few things are decided
 * once for all of them: the two key attributes every row has, the format
 * version every row is stamped with and refused above (record 7), the `ttl`
 * attribute that makes a row absent before DynamoDB's sweep removes it, and the
 * order the server gives string keys. Which segments a feature's keys carry is
 * that feature's `rows` module's decision; that they are written into these
 * attributes and read back in this order is this module's.
 */

import type { QueryCommandInput, ScanCommandInput } from '@aws-sdk/lib-dynamodb';

import { DynamoDBLangGraphError } from '../errors/base-error';
import { ErrorCode } from '../errors/error-code';
import type { AttributeMap } from './client';

/** The attribute every row is partitioned by. */
export const PARTITION_KEY_ATTRIBUTE = 'PK';

/** The attribute every row is sorted by within its partition. */
export const SORT_KEY_ATTRIBUTE = 'SK';

/**
 * Byte caps on caller-supplied identifiers, measured as UTF-8. DynamoDB caps a
 * partition key at 2048 bytes and a sort key at 1024; S3 caps an object key at
 * 1024. These leave room for the adapter prefixes and separators that compose
 * the stored keys, so a value that passes validation fails as a typed error
 * here rather than as a raw AWS ValidationException on the write.
 *
 * Partition-key identifiers: `thread_id` and `sessionId`.
 */
export const MAX_PARTITION_ID_BYTES = 1024;

/**
 * Sort-key segments: `checkpoint_ns`, `checkpoint_id`, `taskId`, a pending-write
 * channel, a store namespace element and a store `key`.
 */
export const MAX_KEY_SEGMENT_BYTES = 256;

/**
 * DynamoDB cap on a whole sort key; composed keys are checked against it too.
 *
 * @see https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.NamingRulesDataTypes.html
 */
export const MAX_SORT_KEY_BYTES = 1024;

/**
 * The separator between the segments of every key this package composes. No
 * caller-supplied identifier may contain it (the parsers refuse it), which is
 * what lets a key be read back into its parts and matched by prefix (record 2).
 */
export const KEY_SEPARATOR = '#';

/**
 * The tag each adapter's partition keys open with. The three differ in their
 * first character, so no two adapters' partitions can collide on a shared
 * table, whatever identifiers their callers reuse (record 2).
 */
export const ADAPTER_TAGS = { checkpointer: 'CHKPT', store: 'STORE', history: 'HIST' } as const;

/** A row's primary key, as a `Key` document and as the key half of an item. */
export interface RowKey {
  PK: string;
  SK: string;
}

/**
 * The key of a row already in hand.
 *
 * Accepts: `row` — an item read from, or about to be written to, the table.
 *
 * Returns: its `PK` and `SK`, and nothing else, so it can be sent as a `Key`
 * without the rest of the item.
 *
 * Throws: nothing.
 */
export function rowKeyOf(row: AttributeMap): RowKey {
  return { PK: row.PK as string, SK: row.SK as string };
}

/** The only attribute this module reads: a row's own format version. */
export interface VersionedRow {
  v?: number;
}

/**
 * The format version this package stamps on every row it writes.
 *
 * Before it existed, "written by an older version" was inferred from a missing
 * attribute — `rev`, `occurrence`, `writeGroup`, `storedChannels`. That
 * inference is unreadable to a maintainer and it is not even expressible: a
 * lookup cannot tell an attribute that is *absent* from one that is *present
 * and undefined*, which reversed first-write-wins for pending writes across an
 * upgrade. A row states its own version instead.
 */
export const ROW_FORMAT_VERSION = 1;

/** The highest version this package knows how to read. */
export const SUPPORTED_ROW_FORMAT_VERSION = 1;

/**
 * A row's format version.
 *
 * Accepts: `row` — any row. One carrying no numeric `v` predates the attribute.
 *
 * Returns: the stamped version, or `0` for a row without one — the version
 * whose rules applied when it was written.
 *
 * Throws: nothing.
 */
export function rowVersionOf(row: VersionedRow): number {
  return typeof row.v === 'number' ? row.v : 0;
}

/**
 * Refuse a row written by a newer version of this package.
 *
 * Accepts: `row` — any row; one at or below
 * {@link SUPPORTED_ROW_FORMAT_VERSION} is accepted, which includes every row
 * written before the attribute existed. `what` — the row kind, named in the
 * message.
 *
 * Returns: nothing: `row` is kept under its declared type, and this checks
 * it.
 *
 * Throws: `FORMAT_UNSUPPORTED` naming the field `v`. Guessing at a shape this
 * version does not know is how a reader returns a checkpoint with silently
 * missing state, so the caller is told to upgrade instead.
 */
export function assertReadableRow(row: VersionedRow, what: string): void {
  const version = rowVersionOf(row);
  if (version <= SUPPORTED_ROW_FORMAT_VERSION) return;
  throw new DynamoDBLangGraphError(
    `this ${what} row was written in format version ${version}; this version of the library ` +
      `reads up to ${SUPPORTED_ROW_FORMAT_VERSION} — upgrade to read it`,
    ErrorCode.FORMAT_UNSUPPORTED,
    { field: 'v' },
  );
}

/**
 * The item with this release's format version stamped on it.
 *
 * Accepts: `item` — any item about to be written; an existing `v` is replaced.
 *
 * Returns: a copy carrying `v`, leaving the input untouched.
 *
 * Throws: nothing.
 */
export function withRowVersion<T extends AttributeMap>(item: T): T & { v: number } {
  return { ...item, v: ROW_FORMAT_VERSION };
}

/**
 * Whether a row has reached its TTL.
 *
 * Accepts: `row` — any row; one without a `ttl` attribute never expires.
 * `nowSeconds` — the current epoch **second**, the unit the attribute uses.
 *
 * Returns: true when `ttl <= nowSeconds`, so the expiry instant itself counts
 * as expired.
 *
 * Throws: nothing.
 *
 * Guarantees: an expired row is absent to every reader even while DynamoDB's
 * own sweep lags, which it may by up to 48 hours
 * (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/howitworks-ttl.html).
 */
export function isExpiredRow(row: { ttl?: number }, nowSeconds: number): boolean {
  return row.ttl !== undefined && row.ttl <= nowSeconds;
}

const TTL_FILTER = 'attribute_not_exists(#ttl) OR #ttl > :now';

/**
 * The same query with expired rows filtered out server-side.
 *
 * Accepts: `params` — a Query or Scan input, with or without a
 * `FilterExpression`; an existing one is ANDed rather than replaced.
 * `nowSeconds` — the epoch second to compare against.
 *
 * Returns: a copy carrying the added filter and the `#ttl` / `:now` aliases. No
 * other call site in this package uses those two names, so the merge cannot
 * shadow a caller's own alias.
 *
 * Throws: nothing.
 *
 * Guarantees: this trims transfer only. It never replaces the in-process
 * {@link isExpiredRow} check, because the query is built and its rows are read
 * at two different instants, and DynamoDB applies a filter *after* `Limit`.
 */
export function withoutExpired<T extends QueryCommandInput | ScanCommandInput>(
  params: T,
  nowSeconds: number,
): T {
  return {
    ...params,
    FilterExpression: params.FilterExpression
      ? `(${params.FilterExpression}) AND (${TTL_FILTER})`
      : TTL_FILTER,
    ExpressionAttributeNames: { ...params.ExpressionAttributeNames, '#ttl': 'ttl' },
    ExpressionAttributeValues: { ...params.ExpressionAttributeValues, ':now': nowSeconds },
  };
}

/**
 * Order two DynamoDB string sort keys the way the server orders them.
 *
 * DynamoDB compares a string key by the bytes of its UTF-8 encoding.
 * JavaScript's `<` and `>` compare UTF-16 code units, and the two disagree
 * wherever an astral character meets one in U+E000-U+FFFF: an astral character
 * is a surrogate pair starting at U+D800, so `'A\u{1F600}' < 'A！'` in
 * JavaScript and the reverse on the server. Any listing that merges or bounds
 * rows in memory and then resumes with a key condition has to use this order,
 * or the boundary it draws is not the boundary the next query reads from, and
 * a row is skipped or handed out twice.
 *
 * The comparison is written on the bytes rather than on code points. The two
 * agree — UTF-8 was designed so that byte order is code-point order — but the
 * bytes are what DynamoDB documents itself as comparing, so the code states the
 * server's rule instead of a property that happens to coincide with it.
 *
 * Accepts: `left`, `right` — any two strings; well-formedness is not required,
 * since an unpaired surrogate encodes to the replacement character's bytes and
 * so still compares deterministically.
 *
 * Returns: a negative number when `left` sorts before `right`, a positive one
 * when it sorts after, and `0` when the two encode to the same bytes.
 *
 * Throws: nothing.
 */
export function compareSortKeys(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
