/**
 * Hides S3 behind one object.
 *
 * The client is built lazily from the optional peer. An upload writes only
 * while its key is free, so a retried upload never replaces another write's
 * object, and carries its row's key as metadata. A download refuses an object
 * over the configured cap before and while reading it. A delete goes out in
 * batches of a thousand, and a best-effort release retries transient failures,
 * never deletes outside the row's own path, and logs rather than throws.
 */

import type { S3Client, ServerSideEncryption } from '@aws-sdk/client-s3';

import { isAbortError } from '../../dynamodb/abort';
import { DEFAULT_SOCKET_TIMEOUT_MS } from '../../dynamodb/client';
import {
  fullJitter,
  isTransientS3Error,
  nextBackoffDelay,
  sleep,
  withRetry,
} from '../../dynamodb/retry';
import { DynamoDBLangGraphError, failureLabel } from '../../errors/base-error';
import { classifyAwsError } from '../../errors/classify';
import { ErrorCode } from '../../errors/error-code';
import { absorbLoggerFailure, type Logger } from '../../logging/logger';
import { redactedMessage } from '../../logging/secret-patterns';
import { truncateForLog } from '../../logging/truncate';
import { createDefaultS3Client, loadS3Sdk } from './client';
import type { S3ClientConfigLike } from './client-types';
import {
  assertKeyInScope,
  buildS3Key,
  DEFAULT_S3_KEY_PREFIX,
  encodeKeyPart,
  isKeyInScope,
  S3OffloadConfig,
} from './config';
import { ensureLifecycleRule } from './lifecycle';

/** Default payload size that triggers S3 offload (350 KB; 50 KB under the DDB 400 KB cap). */
export const DEFAULT_S3_THRESHOLD_BYTES = 350 * 1024;

/** Default S3 server-side encryption algorithm. */
export const DEFAULT_S3_SSE = 'AES256';

/**
 * Default cap on an offloaded object buffered from S3 (50 MiB), checked against
 * `ContentLength` before the body is read and enforced while streaming when
 * the length is unknown. Together with
 * `DEFAULT_MAX_DECOMPRESSED_BYTES` (`src/shared/codec/compression.ts`)
 * it bounds the memory any single payload can claim.
 */
export const DEFAULT_MAX_S3_DOWNLOAD_BYTES = 50 * 1024 * 1024;

/** S3 DeleteObjects maximum keys per request. */
export const S3_DELETE_BATCH_MAX = 1000;

/**
 * Owns the S3 configuration and the lazily-built client; every method is a
 * small delegation to this module's own functions, keyed to that config.
 */
export class S3Offloader {
  private clientPromise: Promise<S3Client> | undefined;
  private resolvedClient: S3Client | undefined;
  private destroyed = false;
  private readonly bucketName: string;
  private readonly keyPrefix: string;
  private readonly thresholdBytes: number;
  private readonly sse: string;
  private readonly sseKmsKeyId?: string;
  private readonly maxDownloadBytes: number;
  private readonly config: S3OffloadConfig;

  /**
   * Accepts: `config` — already validated by the adapter that builds this, with
   * its key prefix resolved to the adapter's own path.
   *
   * Returns: an offloader whose S3 client is built lazily, on the first
   * operation that needs one.
   *
   * Throws: nothing. A missing `@aws-sdk/client-s3` is not raised here: the
   * import is warmed so the failure surfaces, typed, on the first S3 operation
   * rather than on the first oversize payload days later.
   */
  constructor(config: S3OffloadConfig) {
    this.config = config;
    this.bucketName = config.bucketName;
    this.keyPrefix = config.keyPrefix ?? DEFAULT_S3_KEY_PREFIX;
    this.thresholdBytes = config.thresholdBytes ?? DEFAULT_S3_THRESHOLD_BYTES;
    this.sse = config.serverSideEncryption ?? DEFAULT_S3_SSE;
    this.sseKmsKeyId = config.sseKmsKeyId;
    this.maxDownloadBytes = config.maxDownloadBytes ?? DEFAULT_MAX_S3_DOWNLOAD_BYTES;
    /**
     * Warm the optional peer's import so a missing `@aws-sdk/client-s3`
     * surfaces on the very first S3 operation, typed, rather than on the first
     * oversize payload days later. The rejection is handled here; whichever
     * operation runs first re-raises it through its own `loadS3Sdk()` call.
     */
    void loadS3Sdk().catch(() => undefined);
  }

  private getClient(): Promise<S3Client> {
    if (!this.clientPromise) {
      const cfg: S3ClientConfigLike = this.config.clientConfig ?? {};
      /**
       * The hook is typed structurally for consumers; the runtime modules use
       * the real SDK client. It hands over a constructor, not a configuration,
       * so a caller who supplies one has not opted out of the bound: the same
       * default handler {@link createDefaultS3Client} applies reaches it, for
       * the reason recorded there. `cfg` still spreads last, so a caller who
       * does want to replace it puts a `requestHandler` in `clientConfig`.
       */
      this.clientPromise = (
        this.config.createS3Client
          ? Promise.resolve(
              this.config.createS3Client({
                maxAttempts: 1,
                requestHandler: { socketTimeout: DEFAULT_SOCKET_TIMEOUT_MS },
                ...cfg,
              }) as S3Client,
            )
          : createDefaultS3Client(cfg)
      ).then(
        (client) => {
          this.resolvedClient = client;
          /**
           * `destroy()` may have run during this construction, when there was
           * no client yet to release. Release it now instead of leaking it.
           */
          if (this.destroyed) client.destroy();
          return client;
        },
        (error: Error) => {
          this.clientPromise = undefined;
          throw error;
        },
      );
    }
    return this.clientPromise;
  }

  /**
   * Whether `data` is large enough to warrant S3 offload.
   *
   * Accepts: the encoded payload, after compression — what would actually be
   * stored.
   *
   * Returns: whether it reaches `thresholdBytes`. The comparison is inclusive,
   * so a payload exactly at the threshold offloads.
   *
   * Throws: nothing.
   */
  shouldOffload(data: Uint8Array): boolean {
    return data.length >= this.thresholdBytes;
  }

  /**
   * Build the S3 key of the object write `objectId` uploads for the row `parts`
   * identify.
   *
   * Accepts: `parts` — at least one; the row's identity. `objectId` — the
   * uploading write's id, appended as it is: key-safe, with no `/` (see
   * {@link buildS3Key}).
   *
   * Returns: the key, under this offloader's prefix.
   *
   * Throws: `VALIDATION` naming `s3Key` for empty `parts` or a key over
   * S3's 1024-byte cap.
   */
  buildKey(parts: readonly string[], objectId: string): string {
    return buildS3Key(this.keyPrefix, parts, objectId);
  }

  /**
   * The configured key prefix.
   *
   * Accepts: nothing.
   *
   * Returns: the prefix every key this offloader builds starts with, which is
   * what a lifecycle rule is scoped to.
   *
   * Throws: nothing.
   */
  getKeyPrefix(): string {
    return this.keyPrefix;
  }

  /**
   * Whether `key` lies under this offloader's prefix and the `scope` parts'
   * path.
   *
   * Accepts: `key` — any key, including one read off a row. `scope` — the
   * identity of the row that claims it.
   *
   * Returns: whether the row may address that object.
   *
   * Throws: nothing — this is the question form; {@link assertOwnedKey} is the
   * refusing form.
   */
  ownsKey(key: string, scope: readonly string[]): boolean {
    return isKeyInScope(key, this.keyPrefix, scope);
  }

  /**
   * Refuse a row-sourced key outside the row's own path.
   *
   * Accepts: as {@link ownsKey}.
   *
   * Returns: nothing: `key` is kept under its declared type, and this checks
   * it against `scope`.
   *
   * Throws: `VALIDATION`. Every download of a key taken from a row goes
   * through here, so a tampered or foreign row cannot make a reader fetch an
   * object belonging to another row.
   */
  assertOwnedKey(key: string, scope: readonly string[]): void {
    assertKeyInScope(key, this.keyPrefix, scope);
  }

  /**
   * Upload `data` under `key`, writing only while the key is free.
   *
   * Accepts: `key` — built by {@link buildKey} for the write uploading `data`,
   * so no other write uploads to it. `row` — written to the object as the
   * DynamoDB backlink, for an out-of-band sweeper. `signal` — cancels the
   * request itself, not merely the wait before the next attempt.
   *
   * Returns: the key, whether this request stored the object or an earlier
   * attempt of this upload did (see `uploadObject`); the caller's obligation is
   * the same either way.
   *
   * Throws: `S3_OFFLOAD_FAILED` carrying the key; `ABORTED` when the signal
   * fires, which is the caller's own stop rather than a failed offload.
   */
  async upload(
    key: string,
    data: Uint8Array,
    row: BacklinkRow,
    signal?: AbortSignal,
  ): Promise<string> {
    await uploadObject(await this.getClient(), {
      bucket: this.bucketName,
      key,
      data,
      serverSideEncryption: this.sse,
      sseKmsKeyId: this.sseKmsKeyId,
      metadata: backlinkMetadata(row),
      signal,
    });
    return key;
  }

  /**
   * Download the bytes stored under `key`.
   *
   * Accepts: `key` — already checked against the reading row's scope.
   * `signal` — cancels the request, including a body already streaming: the
   * handler's abort listener outlives the response headers and destroys the
   * socket, which is the one bound a stalled transfer has that the request
   * timeout provably does not give it.
   *
   * Returns: the object's bytes.
   *
   * Throws: `S3_OFFLOAD_FAILED` for an object over `maxDownloadBytes` — the cap
   * is enforced on the declared length and again while reading, so a lying
   * `Content-Length` does not get past it — and for a missing object or a
   * transport failure; `ABORTED` when the signal fires.
   */
  async download(key: string, signal?: AbortSignal): Promise<Uint8Array> {
    return downloadObject(
      await this.getClient(),
      { bucket: this.bucketName, key, maxBytes: this.maxDownloadBytes },
      signal,
    );
  }

  /**
   * Delete `keys`.
   *
   * Accepts: any number of keys, including none.
   *
   * Returns: the keys S3 reported as failed, so the caller can log what leaked
   * rather than assume it is gone.
   *
   * Throws: whatever the delete throws after its own retries; cleanup callers
   * catch it, since a failed cleanup must not fail the operation it follows.
   */
  async deleteBatch(keys: string[]): Promise<string[]> {
    return deleteObjects(await this.getClient(), this.bucketName, keys);
  }

  /**
   * Ensure a `${ttlDays}`-day expiration lifecycle rule exists for the prefix.
   *
   * Accepts: `ttlDays` — whole days, the only granularity S3 accepts.
   * `logger` — the adapter's, for the bucket's versioning state, which is
   * reported rather than enforced.
   *
   * Returns: nothing. Rules that are already correct are left alone, so this
   * is safe to call on every deploy.
   *
   * Throws: `VALIDATION` naming `s3.keyPrefix` when a rule id this prefix
   * would take is already held by a different prefix; whatever reading or
   * writing the bucket's lifecycle configuration throws.
   */
  async ensureLifecycleRule(ttlDays: number, logger: Logger): Promise<void> {
    return ensureLifecycleRule(
      await this.getClient(),
      { bucket: this.bucketName, prefix: this.keyPrefix, days: ttlDays },
      logger,
    );
  }

  /**
   * Release the underlying S3 client.
   *
   * Accepts: nothing.
   *
   * Returns: nothing. Safe at any point in the client's lifecycle: called
   * before construction starts it does nothing, called mid-construction it
   * marks the offloader destroyed so the client is released the moment it
   * resolves, and called after it releases it directly.
   *
   * Throws: whatever the SDK client's own `destroy` throws.
   */
  destroy(): void {
    this.destroyed = true;
    this.resolvedClient?.destroy();
  }
}

/** Parameters for {@link uploadObject}. */
export interface UploadParams {
  bucket: string;
  key: string;
  data: Uint8Array;
  serverSideEncryption?: string;
  sseKmsKeyId?: string;
  /** User metadata stored on the object, used for the DynamoDB backlink. */
  metadata?: Record<string, string>;
  /** The caller's cancellation; absent, the upload cannot be interrupted. */
  signal?: AbortSignal;
}

/**
 * Re-throw a cancel as it is, before anything rebrands it.
 *
 * Both wrappers turn every failure into `S3_OFFLOAD_FAILED`, which is right
 * for a failure and wrong for a stop the caller asked for: a cancelled
 * `getMessages` would report that its payload could not be offloaded. The
 * check has to sit ahead of the wrapping rather than inside the classifier,
 * because by then `withRetry` has already decided this is a cancel and said
 * so with the only code a caller branches on.
 */
function rethrowIfCancelled(error: Error): void {
  if (isAbortError(error)) throw error;
}

/**
 * True when S3 refused a conditional write because the key is already taken.
 *
 * With `If-None-Match: *` that is a `412 Precondition Failed` (S3 User Guide,
 * *How to prevent object overwrites with conditional writes*). A key names one
 * write's upload, and only that upload's own requests write it, so the object
 * already there was stored by an earlier attempt of this upload. The upload
 * has nothing left to do, and the 412 is the success case, not a failure. The
 * classifier maps both `PreconditionFailed` and a bare 412 to the same code.
 */
function alreadyStored(error: Error): boolean {
  return classifyAwsError(error) === ErrorCode.CONDITION_CONFLICT;
}

/**
 * Upload `data` to S3 unless an object already exists under `key`, wrapping
 * failures as `S3_OFFLOAD_FAILED`.
 *
 * The write is conditional (`If-None-Match: *`), which costs nothing extra: it
 * needs only `s3:PutObject`, the permission this package already requires, and
 * a retried request writes nothing new: it can never overwrite the object an
 * earlier attempt stored. A `409 Conflict` — S3's answer when a delete lands
 * between the check and the write — is classified as transient and retried
 * like any other conflict.
 *
 * Accepts: `params.key` — the key of one write's upload of `params.data`,
 * written by no other write. `params.metadata` — the backlink, sent with every
 * attempt; an object an earlier attempt stored keeps that attempt's metadata,
 * which is the same. `params.signal` — cancels the request in flight, not only
 * the wait before the next attempt.
 *
 * Returns: nothing, both when this request stored the object and when S3
 * answered `412` because an earlier attempt of this upload already had. The
 * two are not distinguished because the caller's obligation is identical: the
 * bytes are at that key.
 *
 * Throws: `ABORTED` when the signal fires, unwrapped; `S3_OFFLOAD_FAILED`
 * carrying the key and the underlying error, after three attempts on a
 * transient failure. Its message quotes the SDK's, with credential shapes
 * redacted — a signing failure names the key it signed with, and this message
 * reaches `err.message` on a public error.
 *
 * Guarantees: a cancelled upload leaves at most the object it was writing, at
 * a key ending in this write's own object id, which no row names because the
 * row that would have named it is written afterwards. The conditional write
 * means it can never have replaced anything. It is an orphan of exactly the
 * kind `ensureS3LifecycleRule` sweeps, never a corrupted or half-written
 * object: S3 stores a single `PutObject` whole or not at all.
 */
export async function uploadObject(client: S3Client, params: UploadParams): Promise<void> {
  const { PutObjectCommand } = await loadS3Sdk();
  try {
    await withRetry(
      (request) =>
        client.send(
          new PutObjectCommand({
            Bucket: params.bucket,
            Key: params.key,
            Body: params.data,
            ContentType: 'application/octet-stream',
            IfNoneMatch: '*',
            ServerSideEncryption: params.serverSideEncryption as ServerSideEncryption | undefined,
            ...(params.sseKmsKeyId ? { SSEKMSKeyId: params.sseKmsKeyId } : {}),
            ...(params.metadata ? { Metadata: params.metadata } : {}),
          }),
          request,
        ),
      { maxAttempts: 3, isRetryable: isTransientS3Error, signal: params.signal },
    );
  } catch (error) {
    if (alreadyStored(error as Error)) return;
    rethrowIfCancelled(error as Error);
    throw new DynamoDBLangGraphError(
      redactedMessage(error as Error),
      ErrorCode.S3_OFFLOAD_FAILED,
      { operation: 'upload', key: params.key },
      error as Error,
    );
  }
}

/** One object to read: its bucket, its key, and the most bytes it may hold. */
export interface StoredObject {
  readonly bucket: string;
  readonly key: string;
  readonly maxBytes: number;
}

/**
 * The bytes stored under `object.key`.
 *
 * Accepts: `object.maxBytes` — the largest object this call will buffer.
 * `signal` — cancels the request, and with it a body already streaming.
 *
 * Returns: the object's bytes.
 *
 * Throws: `ABORTED` when the signal fires, unwrapped; `S3_OFFLOAD_FAILED`
 * naming the key — for an object over `maxBytes`, for a response with no body,
 * and for any SDK failure that survives the retries. Its message quotes the
 * underlying one with credential shapes redacted; the SDK error is kept as
 * `cause`, so `NoSuchKey` stays distinguishable
 * ({@link isMissingObjectError}).
 *
 * Guarantees: an object over the cap is refused from its declared
 * `ContentLength` before the body is touched, and while streaming when the
 * length is absent, so a replaced or hostile object cannot exhaust memory.
 * Transient failures are retried by this package alone — the client is built
 * with `maxAttempts: 1`.
 *
 * The body is read *inside* the retried attempt, so the signal covers the
 * whole transfer rather than only the round trip to the headers. A signal that
 * fires mid-body destroys the socket, and the stream rejects with a transport
 * error that every classifier here reads as transient; it never reaches that
 * classification, because the signal is read first. A cancelled download
 * leaves nothing behind at all — no local file, no partial object, and the
 * chunks already buffered are dropped with the call.
 */
export async function downloadObject(
  client: S3Client,
  object: StoredObject,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const { GetObjectCommand } = await loadS3Sdk();
  const { bucket, key, maxBytes } = object;
  try {
    return await withRetry(
      async (request) => {
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
          request,
        );
        if (typeof response.ContentLength === 'number' && response.ContentLength > maxBytes) {
          throw oversizedObjectError(key, response.ContentLength, maxBytes);
        }
        if (!response.Body) {
          throw new Error(`S3 object body is empty for key: ${truncateForLog(key)}`);
        }
        return readBodyBounded(response.Body, key, maxBytes);
      },
      { maxAttempts: 3, isRetryable: isTransientS3Error, signal },
    );
  } catch (error) {
    rethrowIfCancelled(error as Error);
    throw new DynamoDBLangGraphError(
      redactedMessage(error as Error),
      ErrorCode.S3_OFFLOAD_FAILED,
      { operation: 'download', key },
      error as Error,
    );
  }
}

/** The part of an S3 `GetObject` body this module relies on. */
export interface S3Body {
  transformToByteArray(): Promise<Uint8Array>;
}

/** A body that can also be consumed chunk by chunk (Node's `IncomingMessage`). */
interface StreamingBody {
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
  destroy?: () => void;
}

/**
 * The typed error for an object over the download cap.
 *
 * Accepts: `bytes` — what the object declared or what had been read when the
 * cap was passed; the message says which is not distinguished, because either
 * way the download stops.
 *
 * Returns: the error, coded `S3_OFFLOAD_FAILED` and carrying the key. The
 * message names the key bounded by {@link truncateForLog}, since it came off
 * a row; `context.key` carries it whole, because that is the field a caller
 * reads and it is one value per failed download rather than one per row.
 *
 * Throws: nothing — it builds the error, the caller throws it.
 */
export function oversizedObjectError(
  key: string,
  bytes: number,
  maxBytes: number,
): DynamoDBLangGraphError {
  return new DynamoDBLangGraphError(
    `S3 object ${truncateForLog(key)} exceeds the ${maxBytes}-byte maxDownloadBytes cap ` +
      `(${bytes} bytes declared or read)`,
    ErrorCode.S3_OFFLOAD_FAILED,
    { operation: 'download', key },
  );
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * The bytes of an S3 body, refused once they pass `maxBytes`.
 *
 * Accepts: `body` — a streaming body (Node's `IncomingMessage`, which the SDK
 * returns) is consumed chunk by chunk; a body offering only
 * `transformToByteArray()` is read whole and then checked. `key` — named in the
 * error. `maxBytes` — the cap; `0` admits only an empty body.
 *
 * Returns: the buffered bytes.
 *
 * Throws: `S3_OFFLOAD_FAILED` naming the key once the total passes `maxBytes`.
 * A streaming body is destroyed at that point, so the rest is never fetched.
 *
 * Guarantees: for a streaming body, peak memory is `maxBytes` plus the one
 * chunk that crossed it — the chunks already held never exceed the cap. For a
 * body without a stream the SDK has already buffered it, so the check bounds
 * what is *returned*, not what was read.
 */
export async function readBodyBounded(
  body: S3Body,
  key: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const streaming = body as S3Body & StreamingBody;
  const iterate = streaming[Symbol.asyncIterator];
  if (typeof iterate !== 'function') {
    const whole = new Uint8Array(await body.transformToByteArray());
    if (whole.length > maxBytes) throw oversizedObjectError(key, whole.length, maxBytes);
    return whole;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of { [Symbol.asyncIterator]: iterate.bind(streaming) }) {
    total += chunk.length;
    if (total > maxBytes) {
      streaming.destroy?.();
      throw oversizedObjectError(key, total, maxBytes);
    }
    chunks.push(chunk);
  }
  return concat(chunks, total);
}

/**
 * Delete `keys` from `bucket`, in chunks of {@link S3_DELETE_BATCH_MAX} — the
 * limit `DeleteObjects` accepts per request.
 *
 * Accepts: `keys` — any length, including empty, which issues no request.
 *
 * Returns: the keys S3 named in an error entry. A per-key failure is reported
 * this way rather than thrown, so the caller (orphan cleanup) decides how
 * loudly to react. An error entry carrying no `Key` cannot be attributed and is
 * not reported.
 *
 * Throws: whatever the SDK rejects with — a request that never reached S3, or
 * one refused whole (permissions, a missing bucket).
 */
export async function deleteObjects(
  client: S3Client,
  bucket: string,
  keys: string[],
): Promise<string[]> {
  if (keys.length === 0) return [];
  const { DeleteObjectsCommand } = await loadS3Sdk();
  const failed: string[] = [];
  for (let offset = 0; offset < keys.length; offset += S3_DELETE_BATCH_MAX) {
    const chunk = keys.slice(offset, offset + S3_DELETE_BATCH_MAX);
    const response = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: chunk.map((key) => ({ Key: key })), Quiet: true },
      }),
    );
    for (const error of response.Errors ?? []) {
      if (error.Key) failed.push(error.Key);
    }
  }
  return failed;
}

/** The DynamoDB key an offloaded object belongs to. */
export interface BacklinkRow {
  pk: string;
  sk: string;
}

/**
 * Metadata names carrying the backlink. S3 lower-cases user-metadata keys, so
 * these are already lower-case; the `-b64` suffix states the encoding, because
 * a sweeper has to decode them to query DynamoDB.
 */
const PK_FIELD = 'dynamodb-pk-b64';
const SK_FIELD = 'dynamodb-sk-b64';

/**
 * The S3 user metadata linking an object back to the DynamoDB row that points
 * at it — the maintenance aid AWS names for this layout: "Store the primary key
 * value of the item as Amazon S3 metadata of the object" (*Best practices for
 * storing large items and attributes in DynamoDB*). Nothing in this package
 * reads it; it lets an out-of-band sweeper ask DynamoDB whether an object's
 * parent row still exists without parsing object keys.
 *
 * Both values are base64url-encoded. A `thread_id` or a store key may hold any
 * well-formed UTF-16 text, while S3 metadata travels in HTTP headers and the
 * User Guide asks for US-ASCII there; encoding unconditionally keeps every
 * value header-safe and keeps the decoding rule single, which a conditional
 * encoding would not.
 *
 * The pair fits S3's 2 KB metadata budget by construction, not by luck: the
 * same identifiers are already base64url-encoded into the object key, which
 * `buildS3Key` caps at 1024 bytes, so anything that produces a usable key
 * leaves these values far below the budget. `offloader-backlink.test.ts` pins
 * that.
 *
 * Accepts: `row` — the DynamoDB key of the row that will point at the object.
 *
 * Returns: the two metadata fields, both base64url.
 *
 * Throws: nothing.
 */
export function backlinkMetadata(row: BacklinkRow): Record<string, string> {
  return { [PK_FIELD]: encodeKeyPart(row.pk), [SK_FIELD]: encodeKeyPart(row.sk) };
}

/**
 * The total UTF-8 bytes `metadata` costs against S3's 2 KB user-metadata cap.
 *
 * Accepts: any metadata map. Names and values both count, which is how S3
 * measures it.
 *
 * Returns: the byte total.
 *
 * Throws: nothing.
 */
export function metadataBytes(metadata: Record<string, string>): number {
  return Object.entries(metadata).reduce(
    (total, [name, value]) =>
      total + Buffer.byteLength(name, 'utf8') + Buffer.byteLength(value, 'utf8'),
    0,
  );
}

const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 100;

/** What one release of orphaned objects needs. */
export interface OrphanRelease {
  /** The keys to delete; an absent or empty one is skipped. */
  readonly keys: ReadonlyArray<string | undefined>;
  /** Names the operation in the log lines, e.g. `putWrites`. */
  readonly operation: string;
  readonly logger: Logger;
  /** The row's own leading key parts, when the keys were read back from a row. */
  readonly scope?: readonly string[];
  readonly rng?: () => number;
  readonly maxAttempts?: number;
  readonly signal?: AbortSignal;
}

/**
 * Wait out one backoff window, cancellable via `release.signal`. Resolves `true`
 * when the signal aborts the wait (so the caller stops retrying) and `false`
 * otherwise — never rejects, preserving the best-effort, non-throwing contract.
 */
async function backoffSleep(delayMs: number, release: OrphanRelease): Promise<boolean> {
  try {
    await sleep(fullJitter(delayMs, release.rng), release.signal);
    return false;
  } catch {
    return true;
  }
}

/** Drop every key outside the row's scope, reporting each one. */
function ownedOnly(
  offloader: S3Offloader,
  keys: string[],
  release: OrphanRelease,
  scope: readonly string[],
): string[] {
  return keys.filter((key) => {
    if (offloader.ownsKey(key, scope)) return true;
    absorbLoggerFailure(() =>
      release.logger.warn(
        `${release.operation}: refusing to delete an S3 object outside this row's scope`,
        {
          key: truncateForLog(key),
        },
      ),
    );
    return false;
  });
}

/** The non-empty keys, restricted to the row's scope when one is given. */
function selectOrphans(offloader: S3Offloader, release: OrphanRelease): string[] {
  const present = release.keys.filter(
    (key): key is string => typeof key === 'string' && key.length > 0,
  );
  return release.scope ? ownedOnly(offloader, present, release, release.scope) : present;
}
/**
 * Best-effort delete of S3 objects orphaned by a failed DynamoDB write.
 *
 * Accepts: `release.keys` — may hold `undefined` and empty entries, which are
 * dropped; nothing left means no request. `release.operation` — names the
 * operation in every log line. `release.scope` — the row's own leading key
 * parts when `keys` came from a row: a key outside that path is reported and
 * never deleted. Own uploads pass no scope. `release.maxAttempts` — attempts
 * on a transient failure, default 3. `release.signal` — aborts the wait
 * between attempts.
 *
 * Returns: nothing.
 *
 * Throws: **nothing**, ever. This is the library's sole non-throwing path: a
 * cleanup failure must not mask the write failure that caused it. Every
 * outcome that is not a clean delete is logged at `warn`, carrying counts and
 * the failing error's *name* — never its message, which can hold a credential
 * fragment. A `logger` that throws is one more thing this absorbs (see
 * `absorbLoggerFailure`): the promise covers the caller's own code too,
 * or every call site's `catch` would hand its caller the wrong error. Every
 * logger reaching here through an adapter is already contained at
 * `resolveLogger`; the guard stays because this promise is written without a
 * precondition, and a `logger` is an argument.
 *
 * Guarantees: an object outside the row's scope is never deleted. Leftovers
 * have no automatic backstop — an S3 lifecycle rule sweeps them only if one was
 * provisioned through `ensureS3LifecycleRule()`, which is opt-in.
 */
export async function cleanUpS3Orphans(
  offloader: S3Offloader,
  release: OrphanRelease,
): Promise<void> {
  const orphans = selectOrphans(offloader, release);
  if (orphans.length === 0) return;
  const maxAttempts = release.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let delay = BASE_DELAY_MS;
  let lastError = new Error('S3 orphan cleanup did not run');
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const failed = await offloader.deleteBatch(orphans);
      if (failed.length === 0) return;
      /**
       * Absorbed here and not by the `catch` below, which would read a broken
       * logger as a failed delete: the delete succeeded, and only part of it
       * could be reported.
       */
      absorbLoggerFailure(() =>
        release.logger.warn(
          `Some orphaned S3 objects could not be deleted after ${release.operation}; a lifecycle rule from ensureS3LifecycleRule() would sweep them, otherwise clean up manually`,
          { failedCount: failed.length },
        ),
      );
      return;
    } catch (error) {
      lastError = error as Error;
      if (attempt >= maxAttempts || !isTransientS3Error(lastError)) break;
      if (await backoffSleep(delay, release)) break;
      delay = nextBackoffDelay(delay);
    }
  }
  /**
   * The error's *name*, never its message: an underlying failure can carry a
   * credential fragment in its text, and this package promises that its logs
   * hold identifiers and counts only. Bounded all the same — a name is an
   * identifier this package did not length-check, and `message` is bounded
   * where `redactedMessage` relays it, so bounding one and relaying the other
   * whole would split what is one value.
   */
  absorbLoggerFailure(() =>
    release.logger.warn(
      `Failed to clean up orphaned S3 objects after ${release.operation}; a lifecycle rule from ensureS3LifecycleRule() would sweep them, otherwise clean up manually`,
      { reason: truncateForLog(failureLabel(lastError)) },
    ),
  );
}
