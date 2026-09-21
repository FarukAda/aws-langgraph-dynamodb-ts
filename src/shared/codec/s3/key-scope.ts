import { ValidationError } from '../../errors/errors';

/**
 * One key part, base64url-encoded.
 *
 * Accepts: `part` — any string, including empty.
 *
 * Returns: base64url text, whose alphabet (`A-Z a-z 0-9 - _`) contains neither
 * `/` nor `.`, so an encoded part can never be mistaken for a path separator
 * or the `.bin` suffix.
 *
 * Throws: nothing.
 */
export function encodeKeyPart(part: string): string {
  return Buffer.from(part, 'utf8').toString('base64url');
}

/**
 * The path every key built from `parts` shares.
 *
 * Accepts: `prefix` — the configured key prefix, ending in `/`. `parts` —
 * the row's identifiers; `[]` yields the prefix alone.
 *
 * Returns: the prefix plus the encoded parts joined by `/`, carrying neither
 * `.bin` nor a trailing `/`.
 *
 * Throws: nothing.
 */
export function s3KeyScope(prefix: string, parts: readonly string[]): string {
  return `${prefix}${parts.map(encodeKeyPart).join('/')}`;
}

/**
 * Whether `key` lies inside the path `parts` produce.
 *
 * Accepts: `key` — a key read back from a row, or one this package built.
 * `parts` — the row's leading identifiers; `[]` degrades to a prefix-only
 * check.
 *
 * Returns: true when the key continues below the scope (`<scope>/…`, which is
 * every key this release writes, since the write's object id is one segment
 * deeper) or equals it (`<scope>.bin`, the key of a store item offloaded by a
 * release that gave the key no per-write segment).
 *
 * Throws: nothing.
 *
 * Guarantees: an identifier sharing a leading substring with another (`t` and
 * `t1`) never matches its scope — the parts are base64url-encoded and joined
 * by `/`, so the comparison is segment-wise, not textual.
 */
export function isKeyInScope(key: string, prefix: string, parts: readonly string[]): boolean {
  const scope = s3KeyScope(prefix, parts);
  if (parts.length === 0) return key.startsWith(scope);
  return key === `${scope}.bin` || key.startsWith(`${scope}/`);
}

/**
 * Refuse a row-sourced `s3Key` outside the path the row's own identifiers
 * produce.
 *
 * Accepts: as {@link isKeyInScope}.
 *
 * Returns: nothing; acceptance is the absence of a throw.
 *
 * Throws: ValidationError naming `s3Key`, quoting the path the row may
 * reference. It reaches the caller on all three adapters, including
 * `history.getMessages` under `onCorruptMessage: 'skip'`, because
 * `isPermanentPayloadLoss` does **not** classify it — an out-of-scope key is
 * not the same kind of thing as an unreadable descriptor. An unreadable
 * descriptor condemns the payload itself: nobody can read those bytes, so
 * skipping the row loses nothing that was ever retrievable. An out-of-scope
 * key says only that *this* reader may not follow it — the object is very
 * likely intact, under the prefix that does own it — and what produced it is a
 * `keyPrefix` pointed at the wrong place, a table shared with another tenant,
 * or a planted row. Every one of those is a condition an operator must see and
 * can fix. Classifying it as loss made only `history` answer with a silently
 * shorter conversation — the one adapter that consults the classifier — which
 * the chain then re-persisted as the truth, while the store and the saver
 * raised on the same row. A short answer is the one failure a caller cannot
 * detect, and one row shape must not mean two things across three adapters.
 *
 * Guarantees: a row is trusted for its shape, never for the object it points
 * at. A writer able to place one row in a partition cannot make this library
 * download or delete another tenant's object, nor make it quietly return less.
 */
export function assertKeyInScope(key: string, prefix: string, parts: readonly string[]): void {
  if (isKeyInScope(key, prefix, parts)) return;
  throw new ValidationError(
    `s3Key "${key}" lies outside the S3 path this row may reference ` +
      `("${s3KeyScope(prefix, parts)}"); refusing to touch an object the row does not own`,
    's3Key',
  );
}
