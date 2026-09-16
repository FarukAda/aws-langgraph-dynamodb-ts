import { ValidationError } from '../errors/errors';
import type { IndexTag } from './index-keys';
import type { DocItem } from './types';

/**
 * The timestamp a row written before the index gets.
 *
 * Checkpoint META rows carry no write time of their own, so a backfilled one
 * has nothing truthful to sort by. The epoch is the honest answer: every row
 * that predates the index sorts below every row written after it, which is the
 * only ordering claim that is actually true. Among themselves they order by id,
 * which is arbitrary and documented as such.
 */
export const BACKFILLED_AT = '1970-01-01T00:00:00.000Z';

/** How a row appears in the recency index. */
export interface IndexTarget {
  tag: IndexTag;
  id: string;
  at: string;
}

/**
 * The index identity of a row, or undefined when no listing reaches its kind.
 *
 * Only the row kinds a listing crosses partitions for are indexed: checkpoint
 * `META`, store items and history `SESSION`. Payload, write and message rows
 * are always read within one partition, so indexing them would pay an extra
 * write for an access pattern that does not exist.
 *
 * Accepts: `row` — any row a table scan returns, including a foreign one and
 * one whose `PK`/`SK` are not strings.
 *
 * Returns: the index identity, or undefined for a row no listing reaches — a
 * foreign row, a payload or write row, a META row carrying no `checkpointId`.
 *
 * Throws: nothing. A backfill walks the whole table; one unrecognised row must
 * be skipped, not fatal.
 */
export function indexTargetOf(row: DocItem): IndexTarget | undefined {
  const pk = typeof row.PK === 'string' ? row.PK : '';
  const sk = typeof row.SK === 'string' ? row.SK : '';
  if (pk.startsWith('CHKPT#')) {
    return sk.startsWith('META#') && typeof row.checkpointId === 'string'
      ? { tag: 'CHKPT', id: row.checkpointId, at: BACKFILLED_AT }
      : undefined;
  }
  if (pk.startsWith('STORE#')) {
    return { tag: 'STORE', id: sk, at: timestampOf(row) };
  }
  if (pk.startsWith('HIST#')) {
    return sk.endsWith('SESSION') && typeof row.sessionId === 'string'
      ? { tag: 'SESS', id: row.sessionId, at: timestampOf(row) }
      : undefined;
  }
  return undefined;
}

/** A row's own update time when it has one, else the pre-index epoch. */
function timestampOf(row: DocItem): string {
  return typeof row.updatedAt === 'string' ? row.updatedAt : BACKFILLED_AT;
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
export function encodeScanCursor(key: DocItem): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

/** Whether `value` is exactly the base table's primary key: `PK` and `SK`, both strings, nothing else. */
function isTableKeyShape(value: DocItem): boolean {
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
 * Throws: ValidationError naming `cursor` for anything this tool did not
 * issue — text that is not base64url, that does not decode to JSON, or that
 * decodes to anything but `{ PK: string, SK: string }`: an array, an object
 * missing either key, carrying an extra one, or carrying a non-string value
 * for either. A cursor is fed straight back to DynamoDB as
 * `ExclusiveStartKey`, so a value of the wrong shape is refused here rather
 * than surfacing as a raw `ValidationException` from the service.
 */
export function decodeScanCursor(cursor: string): DocItem {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as DocItem;
    if (!isTableKeyShape(decoded)) throw new Error('not a scan position');
    return decoded;
  } catch {
    throw new ValidationError('cursor is not one this tool issued', 'cursor');
  }
}
