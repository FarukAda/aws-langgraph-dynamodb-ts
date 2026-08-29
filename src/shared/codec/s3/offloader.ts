import type { S3Client } from '@aws-sdk/client-s3';

import { DEFAULT_S3_KEY_PREFIX, DEFAULT_S3_SSE, DEFAULT_S3_THRESHOLD_BYTES } from '../../constants';
import { createDefaultS3Client } from './client';
import { buildS3Key, S3OffloadConfig } from './config';
import { deleteObjects } from './delete';
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
  private readonly config: S3OffloadConfig;

  constructor(config: S3OffloadConfig) {
    this.config = config;
    this.bucketName = config.bucketName;
    this.keyPrefix = config.keyPrefix ?? DEFAULT_S3_KEY_PREFIX;
    this.thresholdBytes = config.thresholdBytes ?? DEFAULT_S3_THRESHOLD_BYTES;
    this.sse = config.serverSideEncryption ?? DEFAULT_S3_SSE;
    this.sseKmsKeyId = config.sseKmsKeyId;
  }

  private getClient(): Promise<S3Client> {
    if (!this.clientPromise) {
      const cfg = this.config.clientConfig ?? {};
      this.clientPromise = (
        this.config.createS3Client
          ? Promise.resolve(this.config.createS3Client({ maxAttempts: 1, ...cfg }))
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

  /** True when `data` is large enough to warrant S3 offload. */
  shouldOffload(data: Uint8Array): boolean {
    return data.length >= this.thresholdBytes;
  }

  /** Build the S3 key for the given key parts. */
  buildKey(parts: readonly string[]): string {
    return buildS3Key(this.keyPrefix, parts);
  }

  /** The configured key prefix. */
  getKeyPrefix(): string {
    return this.keyPrefix;
  }

  /** Upload `data` under `key`, returning the key. */
  async upload(key: string, data: Uint8Array): Promise<string> {
    await uploadObject(await this.getClient(), {
      bucket: this.bucketName,
      key,
      data,
      serverSideEncryption: this.sse,
      sseKmsKeyId: this.sseKmsKeyId,
    });
    return key;
  }

  /** Download the bytes stored under `key`. */
  async download(key: string): Promise<Uint8Array> {
    return downloadObject(await this.getClient(), this.bucketName, key);
  }

  /** Delete `keys`, returning the keys S3 reported as failed. */
  async deleteBatch(keys: string[]): Promise<string[]> {
    return deleteObjects(await this.getClient(), this.bucketName, keys);
  }

  /** Ensure a `${ttlDays}`-day expiration lifecycle rule exists for the prefix. */
  async ensureLifecycleRule(ttlDays: number): Promise<void> {
    return ensureLifecycleRule(await this.getClient(), this.bucketName, this.keyPrefix, ttlDays);
  }

  /**
   * Release the underlying S3 client. Safe at any point in the client's
   * lifecycle: called before construction starts it does nothing, called
   * mid-construction it marks the offloader destroyed so the client is
   * released the moment it resolves, and called after it releases it directly.
   */
  destroy(): void {
    this.destroyed = true;
    this.resolvedClient?.destroy();
  }
}
