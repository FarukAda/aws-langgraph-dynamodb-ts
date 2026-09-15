import { createHash } from 'node:crypto';

/**
 * The content address of `bytes`: their SHA-256 digest, base64url-encoded.
 *
 * 43 characters, and every one of them is safe in an S3 object key — the
 * base64url alphabet is `A-Z a-z 0-9 - _`, so the digest is appended to a key
 * verbatim rather than encoded again. Hex would be 64 characters for the same
 * digest, and an object key is capped at 1024 bytes.
 *
 * This is an address, not a credential: it is derived from bytes the caller
 * supplied, so it proves nothing about who wrote them. What it buys is that the
 * same bytes always name the same object, which is what makes an upload
 * idempotent and a retry a no-op instead of a second object.
 *
 * Accepts: any bytes, including none.
 *
 * Returns: 43 base64url characters, the same ones for the same bytes on every
 * machine and every release.
 *
 * Throws: nothing.
 */
export function contentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('base64url');
}
