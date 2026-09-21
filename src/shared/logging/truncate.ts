import { MAX_LOGGED_VALUE_CHARS } from '../constants';

/** True for the high half of a surrogate pair, whose low half follows it. */
function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

/**
 * Bound a row-sourced string a log line quotes.
 *
 * **The rule, in one sentence:** a string a log line quotes goes through here
 * when it came off a row, and goes in as it is when this package composed it
 * from identifiers it validated. A caller's `sessionId`, `threadId`,
 * `namespace` and `key`, and every key built from them, are already capped by
 * `MAX_PARTITION_ID_BYTES`, `MAX_KEY_SEGMENT_BYTES` and `MAX_SORT_KEY_BYTES`
 * before a request is made; a row's own `SK`, an offloaded object's key, and
 * an attribute read back off a row that turned a write away are bounded by
 * nothing this package ran. The lines that quote those are the ones that fire
 * per row on a foreign or hand-written table, so they are the ones that can
 * fill a log.
 *
 * Accepts: `value` — the attribute as the row carried it. Declared `string`
 * because a table's own key attributes always are; anything else is returned
 * untouched rather than coerced or refused, since a warning about a row that
 * is already wrong is the last place to raise a `TypeError` of its own.
 *
 * Returns: the value unchanged at or under {@link MAX_LOGGED_VALUE_CHARS}
 * characters, otherwise that many characters followed by `…(len N)` giving the
 * length it really had. The mark is what keeps a cut value honest: without it
 * a truncated key reads as a key that simply ends there.
 *
 * Throws: nothing.
 *
 * Guarantees: a cut never falls between the halves of a surrogate pair, so a
 * well-formed value stays well-formed. A lone surrogate is what
 * `assertWellFormed` exists to keep out of this package's strings, and a JSON
 * log transport rewrites one to U+FFFD without saying so.
 */
export function truncateForLog(value: string): string {
  if (typeof value !== 'string' || value.length <= MAX_LOGGED_VALUE_CHARS) return value;
  const last = value.charCodeAt(MAX_LOGGED_VALUE_CHARS - 1);
  const kept = isHighSurrogate(last) ? MAX_LOGGED_VALUE_CHARS - 1 : MAX_LOGGED_VALUE_CHARS;
  return `${value.slice(0, kept)}…(len ${value.length})`;
}
