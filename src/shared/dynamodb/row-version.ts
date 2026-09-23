import { DynamoDBLangGraphError } from '../errors/base-error';
import { ErrorCode } from '../errors/error-code';
import type { DocItem } from './types';

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
export function withRowVersion<T extends DocItem>(item: T): T & { v: number } {
  return { ...item, v: ROW_FORMAT_VERSION };
}
