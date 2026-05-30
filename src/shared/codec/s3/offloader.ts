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
  private client: S3Client | undefined;
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

  private async getClient(): Promise<S3Client> {
    if (!this.client) {
      const cfg = this.config.clientConfig ?? {};
      this.client = this.config.createS3Client
        ? this.config.createS3Client(cfg)
        : await createDefaultS3Client(cfg);
    }
    return this.client;
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

  /** Release the underlying S3 client, if one was created. */
  destroy(): void {
    this.client?.destroy();
  }
}
