/**
 * Hides the S3 key layout: where a row's object lives, and which keys a row may touch.
 *
 * An offloaded object's key is the adapter's prefix, then the row's own
 * identifiers each base64url-encoded, then the id of the write that produced
 * it, so a key read back from a row can be checked against the path that row
 * could have produced before anything is read or deleted. The configuration a
 * caller passes, its checks, the default prefix per adapter and the lifecycle
 * rule ids derived from a prefix are part of the same layout.
 */

import type { DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';

import { DEFAULT_S3_KEY_PREFIX, MAX_S3_KEY_BYTES } from '../../constants';
import { validationError } from '../../errors/errors';
import { truncateForLog } from '../../logging/truncate';
import { assertNoControlChars, assertWellFormed } from '../../validation/primitives';
import { s3ClientOptions } from './client-types';
import type { S3ClientConfigLike, S3ClientLike } from './client-types';

/** Configuration for offloading large payloads to S3. */
export interface S3OffloadConfig {
  bucketName: string;
  keyPrefix?: string;
  /**
   * Serialized payloads at or above this size are offloaded (default 350 KB).
   * Only the payload counts: the store's inline embedding (about 10 bytes per
   * dimension, so ~10 KB at 1024 dims and ~45 KB at 4096) lives on the same
   * item and is not part of it, so keep `thresholdBytes` plus the embedding
   * under DynamoDB's 400 KB item limit or the put fails with a raw
   * `ValidationException`.
   */
  thresholdBytes?: number;
  serverSideEncryption?: string;
  sseKmsKeyId?: string;
  /** Largest object this adapter will buffer from S3 (default 50 MiB). */
  maxDownloadBytes?: number;
  /**
   * S3 client configuration (an `S3ClientConfig`). `region` defaults to the
   * adapter's DynamoDB region.
   */
  clientConfig?: S3ClientConfigLike;
  /**
   * @internal Test seam and dependency-injection hook for constructing the
   * S3 client; not part of the supported surface and absent from the
   * shipped declarations.
   */
  createS3Client?: (config: S3ClientConfigLike) => S3ClientLike;
}

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
 * Build a fully-qualified S3 key: `${prefix}${parts, each base64url-encoded,
 * joined with '/'}/${objectId}.bin`.
 *
 * `parts` are the identity of the DynamoDB row that will point at the object,
 * and they are encoded rather than rejected: a namespace element or key may
 * contain '/' (only the DynamoDB '#' separator is forbidden at the validation
 * layer), and base64url's output alphabet never contains '/', so two distinct
 * `parts` arrays can never compose one key.
 *
 * `objectId` names the write that uploads the object and is appended as it
 * is, not encoded, so it must be safe in an S3 key and hold no `/`, or its
 * segments would read as parts. The ids this package passes are both: a UUID
 * (hex digits and `-`) and a ULID (Crockford base-32 digits).
 *
 * Accepts: `prefix` — the offloader's, already validated and separator-
 * terminated. `parts` — at least one; the identity of the row that will point
 * at the object. `objectId` — the uploading write's id: key-safe, with no `/`.
 *
 * Returns: the key. Under one prefix, two distinct `(parts, objectId)` pairs
 * never compose one key, and the same prefix, parts and id always compose the
 * same one.
 *
 * Throws: `VALIDATION` naming `s3Key` for an empty `parts` — an object with
 * no row above it is outside every row's scope and could never be read back —
 * and for a key over the 1024-byte cap. The encoding grows every part by a
 * third, so identifiers that each pass their own length rule can still compose
 * a key S3 would reject with a raw error.
 */
export function buildS3Key(prefix: string, parts: readonly string[], objectId: string): string {
  if (parts.length === 0) {
    throw validationError(
      'an offloaded object needs the identity of the row that points at it; parts was empty',
      's3Key',
    );
  }
  const encoded = [...parts.map(encodeKeyPart), objectId];
  const key = `${prefix}${encoded.join('/')}.bin`;
  const bytes = Buffer.byteLength(key, 'utf8');
  if (bytes > MAX_S3_KEY_BYTES) {
    throw validationError(
      `the offloaded S3 object key would be ${bytes} bytes; S3 caps keys at ` +
        `${MAX_S3_KEY_BYTES} — shorten the identifiers or the keyPrefix`,
      's3Key',
    );
  }
  return key;
}

/** A path segment that names something other than itself, or nothing at all. */
const UNSCOPED_SEGMENTS = new Set(['', '.', '..']);

/**
 * Refuse a key prefix that does not scope what it is used for.
 *
 * Accepts: `keyPrefix` — must be a string, non-empty, not `/`, and end in `/`.
 * The type is checked here, before any string method is called, so every
 * caller gets it: a number or `null` escaped as a bare `TypeError` from
 * `keyPrefix.endsWith`. Every segment before that final `/` must be a real
 * name: not empty, not `.`, not `..`. The whole prefix must also be free of
 * control characters and well-formed UTF-16, the rules identifiers already
 * meet, since it is written into log lines and into a lifecycle rule's filter.
 *
 * Returns: nothing: the value is kept under its declared type, and this
 * checks it.
 *
 * Throws: `VALIDATION` naming `s3.keyPrefix`. The shape rule is reported
 * before the segment rule, so a prefix breaking both is named by its shape.
 *
 * Guarantees: the prefix scopes both the objects and the lifecycle rule built
 * from it. An empty or root prefix would make that rule expire the whole
 * bucket, and one without a trailing `/` (`app/langgraph`) would also match
 * every sibling starting with the same characters (`app/langgraph-other/`).
 * An accepted prefix also survives path normalisation unchanged, which is what
 * the segment rule buys. An S3 key is a byte string rather than a path, so
 * `a/../b/x.bin` and `b/x.bin` are two different objects — but the IAM
 * object-key condition a deployment writes, the lifecycle rule's
 * `Filter.Prefix`, the console and every tool that resolves a path before
 * matching one disagree about which. A prefix holding `..`, `.` or an empty
 * segment therefore writes objects outside the path the deployment granted and
 * outside the path the lifecycle rule sweeps, which is the whole job of a
 * prefix.
 */
export function assertScopedKeyPrefix(keyPrefix: string): void {
  if (
    typeof keyPrefix !== 'string' ||
    keyPrefix === '' ||
    keyPrefix === '/' ||
    !keyPrefix.endsWith('/')
  ) {
    throw validationError(
      's3.keyPrefix must be a non-empty path that ends with "/" (for example "langgraph/"): ' +
        'it scopes both the offloaded objects and the S3 lifecycle rule',
      's3.keyPrefix',
    );
  }
  assertNoControlChars(keyPrefix, 's3.keyPrefix');
  assertWellFormed(keyPrefix, 's3.keyPrefix');
  if (
    keyPrefix
      .slice(0, -1)
      .split('/')
      .some((segment) => UNSCOPED_SEGMENTS.has(segment))
  ) {
    throw validationError(
      's3.keyPrefix must name a real path: no empty, "." or ".." segment (for example ' +
        '"langgraph/", not "../langgraph/" or "/langgraph/"). Such a prefix addresses object ' +
        'keys outside the path the IAM policy grants and the lifecycle rule sweeps',
      's3.keyPrefix',
    );
  }
}

/**
 * The lifecycle rule id for `prefix`: `langgraph-ttl-` plus its slug.
 *
 * Accepts: `prefix` — any string; trailing slashes are trimmed, and every
 * character outside `[A-Za-z0-9-]` becomes `-`.
 *
 * Returns: a deterministic id that does not change with the TTL, so raising or
 * lowering the TTL updates one rule rather than adding another. A prefix with
 * no usable characters yields `langgraph-ttl-default`.
 *
 * Throws: nothing.
 *
 * Guarantees: the slug is not injective — `a/b/` and `a-b/` produce one id —
 * and `ensureLifecycleRule` refuses rather than take over a rule that a
 * different prefix already holds.
 */
export function buildLifecycleRuleId(prefix: string): string {
  let trimmed = prefix;
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  const slug = trimmed.replace(/[^a-zA-Z0-9-]/g, '-') || 'default';
  return `langgraph-ttl-${slug}`;
}

/**
 * The id of the rule that reclaims this prefix's expired delete markers:
 * {@link buildLifecycleRuleId}'s id with a suffix of its own.
 *
 * Accepts: `prefix` — as {@link buildLifecycleRuleId} takes it.
 *
 * Returns: a second deterministic id, distinct from the expiration rule's.
 * S3 refuses `ExpiredObjectDeleteMarker` inside an `Expiration` that also
 * carries `Days`, so the reclaim cannot be a field on that rule and needs an
 * id to be found by.
 *
 * Throws: nothing.
 *
 * Guarantees: it is *less* injective than the first id rather than merely as
 * injective. On top of the slug collisions that one already has,
 * `buildMarkerRuleId('app/')` and `buildLifecycleRuleId('app-markers/')` are
 * one id — a clash between two prefixes whose letters and digits differ, which
 * the first id alone cannot produce. `ensureLifecycleRule` refuses to take
 * over either id when a different prefix already holds it, and its refusal
 * names the suffix so the remedy fits the case.
 */
export function buildMarkerRuleId(prefix: string): string {
  return `${buildLifecycleRuleId(prefix)}-markers`;
}

/**
 * An adapter's default S3 key prefix.
 *
 * Accepts: `base` — the shared prefix, ending in `/`. `adapter` — the adapter's
 * own segment.
 *
 * Returns: `base` + `adapter` + `/`, so three adapters sharing one bucket write
 * under three paths and one adapter's lifecycle rule never sweeps another's
 * objects.
 *
 * Throws: nothing.
 */
export function defaultAdapterKeyPrefix(base: string, adapter: string): string {
  return `${base}${adapter}/`;
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
 * Returns: nothing: `key` is kept under its declared type, and this checks it
 * against the scope `prefix` and `parts` compose.
 *
 * Throws: `VALIDATION` naming `s3Key`, quoting the key and the path the
 * row may reference, each bounded by {@link truncateForLog}: the key comes off
 * the row and the path is composed from an `s3.keyPrefix` checked for shape
 * and never for length, so neither is bounded by anything this package ran.
 * The key stays named — a bounded prefix still says which object to go and
 * look at. It reaches the caller on all three adapters, including
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
  throw validationError(
    `s3Key "${truncateForLog(key)}" lies outside the S3 path this row may reference ` +
      `("${truncateForLog(s3KeyScope(prefix, parts))}"); refusing to touch an object the row ` +
      'does not own',
    's3Key',
  );
}

/** The adapters that share one bucket, each under its own default key prefix. */
export type AdapterName = 'checkpointer' | 'store' | 'history';

/**
 * An adapter's `s3` option resolved into the offloader's configuration.
 *
 * Accepts: `s3` — as the caller gave it. `adapter` — names the default key
 * prefix, so three adapters sharing one bucket do not share a path.
 * `clientConfig` — the adapter's DynamoDB client config, read for its region
 * only.
 *
 * Returns: `s3` with `keyPrefix` defaulted to the adapter's own path, and
 * `clientConfig.region` filled in from the DynamoDB side when the S3 config
 * names none. With no region on either side the field is left absent and the
 * SDK resolves it from the environment.
 *
 * Throws: nothing.
 *
 * Guarantees: a bucket reachable only through the region the DynamoDB side was
 * configured with is addressed in that region. The S3 SDK does not follow
 * region redirects, so such a bucket otherwise failed with an opaque
 * `PermanentRedirect` on the first offload.
 */
export function offloaderConfigFor(
  s3: S3OffloadConfig,
  adapter: AdapterName,
  clientConfig?: DynamoDBClientConfig,
): S3OffloadConfig {
  const region = s3ClientOptions(s3.clientConfig).region ?? clientConfig?.region;
  return {
    ...s3,
    keyPrefix: s3.keyPrefix ?? defaultAdapterKeyPrefix(DEFAULT_S3_KEY_PREFIX, adapter),
    ...(region === undefined ? {} : { clientConfig: { ...s3.clientConfig, region } }),
  };
}
