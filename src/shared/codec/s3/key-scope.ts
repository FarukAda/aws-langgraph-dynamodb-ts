import { ValidationError } from '../../errors/errors';

/** base64url-encode one key part; the output alphabet never contains `/` or `.`. */
export function encodeKeyPart(part: string): string {
  return Buffer.from(part, 'utf8').toString('base64url');
}

/**
 * The path every key `buildS3Key(prefix, [...parts, ...more])` shares: the
 * prefix plus the encoded `parts` joined by `/`, with neither `.bin` nor a
 * trailing `/`.
 */
export function s3KeyScope(prefix: string, parts: readonly string[]): string {
  return `${prefix}${parts.map(encodeKeyPart).join('/')}`;
}

/**
 * True when `key` was produced by `buildS3Key` from exactly `parts`
 * (`<scope>.bin`) or from `parts` plus further parts (`<scope>/…`). An empty
 * `parts` degrades to a prefix-only check. Because parts are base64url-encoded
 * and joined by `/`, an identifier sharing a leading substring with another
 * (`t` and `t1`) never matches its scope.
 */
export function isKeyInScope(key: string, prefix: string, parts: readonly string[]): boolean {
  const scope = s3KeyScope(prefix, parts);
  if (parts.length === 0) return key.startsWith(scope);
  return key === `${scope}.bin` || key.startsWith(`${scope}/`);
}

/**
 * Refuse a row-sourced `s3Key` that lies outside the path the row's own
 * identifiers produce. A row is trusted for its shape, not for the object it
 * points at: a writer able to place one row in a partition must not be able
 * to make this library download or delete another tenant's object.
 */
export function assertKeyInScope(key: string, prefix: string, parts: readonly string[]): void {
  if (isKeyInScope(key, prefix, parts)) return;
  throw new ValidationError(
    `s3Key "${key}" lies outside the S3 path this row may reference ` +
      `("${s3KeyScope(prefix, parts)}"); refusing to touch an object the row does not own`,
    's3Key',
  );
}
