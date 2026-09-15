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
 * every key this release writes, since the content hash is one segment deeper)
 * or equals it (`<scope>.bin`, as releases before content addressing wrote a
 * store item with no nonce).
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
 * reference. `isPermanentPayloadLoss` treats it as permanent: the row can never
 * be read by this adapter.
 *
 * Guarantees: a row is trusted for its shape, never for the object it points
 * at. A writer able to place one row in a partition cannot make this library
 * download or delete another tenant's object.
 */
export function assertKeyInScope(key: string, prefix: string, parts: readonly string[]): void {
  if (isKeyInScope(key, prefix, parts)) return;
  throw new ValidationError(
    `s3Key "${key}" lies outside the S3 path this row may reference ` +
      `("${s3KeyScope(prefix, parts)}"); refusing to touch an object the row does not own`,
    's3Key',
  );
}
