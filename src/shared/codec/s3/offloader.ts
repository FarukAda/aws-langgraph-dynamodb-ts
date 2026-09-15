import type { S3Client } from '@aws-sdk/client-s3';

import {
  DEFAULT_MAX_S3_DOWNLOAD_BYTES,
  DEFAULT_S3_KEY_PREFIX,
  DEFAULT_S3_SSE,
  DEFAULT_S3_THRESHOLD_BYTES,
} from '../../constants';
import { type BacklinkRow, backlinkMetadata } from './backlink';
import { createDefaultS3Client, loadS3Sdk } from './client';
import type { S3ClientConfigLike } from './client-types';
import { buildS3Key, S3OffloadConfig } from './config';
import { deleteObjects } from './delete';
import { assertKeyInScope, isKeyInScope } from './key-scope';
import { ensureLifecycleRule } from './lifecycle';
import { downloadObject, uploadObject } from './read-write';

/**
 * Thin holder composing the pure S3 functions. Owns config + the lazily-built
 * S3 client and delegates all real work; every method is a small delegation.
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
      /** The hook is typed structurally for consumers; the runtime modules use the real SDK client. */
      this.clientPromise = (
        this.config.createS3Client
          ? Promise.resolve(this.config.createS3Client({ maxAttempts: 1, ...cfg }) as S3Client)
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
   * Build the S3 key addressing `hash` under the row `parts` identify.
   *
   * Accepts: `parts` — at least one; the row's identity. `hash` — the content
   * address of the bytes.
   *
   * Returns: the key, under this offloader's prefix.
   *
   * Throws: ValidationError naming `s3Key` for empty `parts` or a key over
   * S3's 1024-byte cap.
   */
  buildKey(parts: readonly string[], hash: string): string {
    return buildS3Key(this.keyPrefix, parts, hash);
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
   * Returns: nothing; being in scope is the absence of a throw.
   *
   * Throws: ValidationError. Every download of a key taken from a row goes
   * through here, so a tampered or foreign row cannot make a reader fetch an
   * object belonging to another row.
   */
  assertOwnedKey(key: string, scope: readonly string[]): void {
    assertKeyInScope(key, this.keyPrefix, scope);
  }

  /**
   * Upload `data` under `key` unless it is already there.
   *
   * Accepts: `key` — the content address of `data`, so an object already there
   * holds these exact bytes. `row` — written to the object as the DynamoDB
   * backlink, for an out-of-band sweeper.
   *
   * Returns: the key, whether this call uploaded or found the bytes already
   * stored; the caller's obligation is the same either way.
   *
   * Throws: `S3_OFFLOAD_FAILED` carrying the key.
   */
  async upload(key: string, data: Uint8Array, row: BacklinkRow): Promise<string> {
    await uploadObject(await this.getClient(), {
      bucket: this.bucketName,
      key,
      data,
      serverSideEncryption: this.sse,
      sseKmsKeyId: this.sseKmsKeyId,
      metadata: backlinkMetadata(row),
    });
    return key;
  }

  /**
   * Download the bytes stored under `key`.
   *
   * Accepts: `key` — already checked against the reading row's scope.
   *
   * Returns: the object's bytes.
   *
   * Throws: `S3_OFFLOAD_FAILED` for an object over `maxDownloadBytes` — the cap
   * is enforced on the declared length and again while reading, so a lying
   * `Content-Length` does not get past it — and for a missing object or a
   * transport failure.
   */
  async download(key: string): Promise<Uint8Array> {
    return downloadObject(await this.getClient(), this.bucketName, key, this.maxDownloadBytes);
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
   *
   * Returns: nothing. A rule that is already correct is left alone, so this is
   * safe to call on every deploy.
   *
   * Throws: ValidationError naming `s3.keyPrefix` when the rule id this prefix
   * would take is already held by a different prefix; whatever reading or
   * writing the bucket's lifecycle configuration throws.
   */
  async ensureLifecycleRule(ttlDays: number): Promise<void> {
    return ensureLifecycleRule(await this.getClient(), this.bucketName, this.keyPrefix, ttlDays);
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
