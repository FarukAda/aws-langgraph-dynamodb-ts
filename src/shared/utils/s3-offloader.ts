/**
 * S3 offloader for large checkpoint payloads
 *
 * DynamoDB has a hard 400KB item size limit. This utility transparently
 * offloads payloads exceeding a configurable threshold (default: 350KB)
 * to S3, storing only an S3 key reference in DynamoDB.
 *
 * Requires `@aws-sdk/client-s3` as an optional peer dependency.
 *
 * @remarks
 * This module uses synchronous `require()` for lazy loading of the S3 SDK
 * to avoid making the DynamoDBSaver constructor async. This means it
 * requires a CommonJS-compatible environment (Node.js with CJS, or a
 * bundler that polyfills require). Pure ESM environments are not supported.
 */

import { getLogger } from './logger';

/** Default threshold: 350KB (leaves 50KB headroom below DynamoDB's 400KB limit) */
const DEFAULT_THRESHOLD_BYTES = 350 * 1024;

/** Default S3 key prefix for offloaded payloads */
const DEFAULT_KEY_PREFIX = 'langgraph-checkpoints/';

/**
 * Default server-side encryption. Matches S3's own default (SSE-S3, AES256) since
 * January 2023, but asserting it on the PutObject makes the intent explicit for
 * compliance reviews and protects users running against older buckets or custom
 * endpoints that don't inherit the modern default.
 */
const DEFAULT_SERVER_SIDE_ENCRYPTION = 'AES256';

/* eslint-disable @typescript-eslint/no-require-imports -- TODO: migrate to dynamic import() when Jest ESM support is stable */

// Lazy-loaded S3 SDK — uses require() for Jest CJS compatibility.
// Replace with import() when the test runner supports --experimental-vm-modules.
let s3Sdk: typeof import('@aws-sdk/client-s3') | undefined;

function getS3Sdk(): typeof import('@aws-sdk/client-s3') {
  if (!s3Sdk) {
    s3Sdk = require('@aws-sdk/client-s3');
  }
  return s3Sdk!;
}

/**
 * Configuration for S3 offloading
 */
export interface S3OffloadConfig {
  /** S3 bucket name for storing offloaded payloads (required) */
  bucketName: string;
  /** Key prefix for S3 objects (default: 'langgraph-checkpoints/') */
  keyPrefix?: string;
  /** Payload size threshold in bytes that triggers offloading (default: 358400 = 350KB) */
  thresholdBytes?: number;
  /**
   * Server-side encryption algorithm (`'AES256'` or `'aws:kms'`).
   * Defaults to `'AES256'` — pass an explicit value to override (e.g. `'aws:kms'`
   * together with `sseKmsKeyId`).
   */
  serverSideEncryption?: string;
  /** KMS key ID or ARN. Only used when serverSideEncryption is 'aws:kms'. */
  sseKmsKeyId?: string;
  /**
   * Optional S3 client configuration (region, credentials, endpoint, etc.).
   * Accepts any valid S3ClientConfig properties from @aws-sdk/client-s3.
   */
  clientConfig?: {
    region?: string;
    endpoint?: string;
    credentials?: unknown;
    [key: string]: unknown;
  };
  /**
   * Factory seam for constructing the S3 client. Defaults to
   * `new S3Client(clientConfig)`; injectable so tests can supply a stub client
   * without a live AWS connection.
   */
  createS3Client?: (
    config: Record<string, unknown>,
  ) => InstanceType<typeof import('@aws-sdk/client-s3').S3Client>;
}

/**
 * S3 offloader for large checkpoint payloads
 *
 * Transparently uploads large payloads to S3 and returns S3 key references
 * for storage in DynamoDB. On read, downloads from S3 when a reference is present.
 *
 * @example
 * ```typescript
 * const offloader = new S3Offloader({
 *   bucketName: 'my-checkpoints-bucket',
 *   keyPrefix: 'langgraph/',
 *   thresholdBytes: 350 * 1024,
 * });
 *
 * if (offloader.shouldOffload(data)) {
 *   const key = await offloader.upload('thread/checkpoint/field.bin', data);
 *   // Store `key` in DynamoDB instead of `data`
 * }
 * ```
 */
export class S3Offloader {
  private s3Client?: InstanceType<typeof import('@aws-sdk/client-s3').S3Client>;
  private readonly bucketName: string;
  private readonly keyPrefix: string;
  private readonly thresholdBytes: number;
  private readonly serverSideEncryption: string;
  private readonly sseKmsKeyId?: string;
  private readonly clientConfig?: S3OffloadConfig['clientConfig'];
  private readonly createS3Client?: S3OffloadConfig['createS3Client'];

  constructor(config: S3OffloadConfig) {
    this.bucketName = config.bucketName;
    this.keyPrefix = config.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.thresholdBytes = config.thresholdBytes ?? DEFAULT_THRESHOLD_BYTES;
    this.serverSideEncryption = config.serverSideEncryption ?? DEFAULT_SERVER_SIDE_ENCRYPTION;
    this.sseKmsKeyId = config.sseKmsKeyId;
    this.clientConfig = config.clientConfig;
    this.createS3Client = config.createS3Client;
  }

  /**
   * Get or lazily create the S3 client on first use.
   * Defers S3Client construction so the constructor remains lightweight and sync.
   */
  private getClient(): InstanceType<typeof import('@aws-sdk/client-s3').S3Client> {
    if (!this.s3Client) {
      const config = (this.clientConfig ?? {}) as Record<string, unknown>;
      if (this.createS3Client) {
        this.s3Client = this.createS3Client(config);
      } else {
        const { S3Client } = getS3Sdk();
        this.s3Client = new S3Client(config);
      }
    }
    return this.s3Client;
  }

  /**
   * Check whether a payload should be offloaded to S3
   *
   * @param data - Serialized payload
   * @returns true if the payload exceeds the threshold
   */
  shouldOffload(data: Uint8Array): boolean {
    return data.length >= this.thresholdBytes;
  }

  /**
   * Build a fully-qualified S3 key for a checkpoint field
   *
   * @param threadId - Thread identifier
   * @param checkpointId - Checkpoint identifier
   * @param field - Field name (e.g., 'checkpoint', 'metadata', 'write-0')
   * @returns Fully-qualified S3 key
   */
  buildKey(threadId: string, checkpointId: string, field: string): string {
    return `${this.keyPrefix}${threadId}/${checkpointId}/${field}.bin`;
  }

  /**
   * Upload data to S3
   *
   * @param key - S3 object key
   * @param data - Data to upload
   * @returns The S3 key that was used
   */
  async upload(key: string, data: Uint8Array): Promise<string> {
    const { PutObjectCommand } = getS3Sdk();
    const client = this.getClient();

    await client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: data,
        ContentType: 'application/octet-stream',
        ServerSideEncryption: this
          .serverSideEncryption as import('@aws-sdk/client-s3').ServerSideEncryption,
        ...(this.sseKmsKeyId && { SSEKMSKeyId: this.sseKmsKeyId }),
      }),
    );

    return key;
  }

  /**
   * Download data from S3
   *
   * @param key - S3 object key to download
   * @returns The downloaded data as Uint8Array
   * @throws Error if the download fails or body is empty
   */
  async download(key: string): Promise<Uint8Array> {
    const { GetObjectCommand } = getS3Sdk();
    const client = this.getClient();

    const response = await client.send(
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }),
    );

    if (!response.Body) {
      throw new Error(`S3 object body is empty for key: ${key}`);
    }

    // Convert the readable stream to Uint8Array
    const byteArray = await response.Body.transformToByteArray();
    return new Uint8Array(byteArray);
  }

  /**
   * Delete a single object from S3
   *
   * @param key - S3 object key to delete
   */
  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = getS3Sdk();
    const client = this.getClient();

    await client.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }),
    );
  }

  /**
   * Batch delete multiple objects from S3
   *
   * @param keys - Array of S3 object keys to delete
   */
  async deleteBatch(keys: string[]): Promise<void> {
    if (keys.length === 0) return;

    const { DeleteObjectsCommand } = getS3Sdk();
    const client = this.getClient();

    // S3 DeleteObjects supports up to 1000 keys per request
    const batchSize = 1000;
    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize);
      const response = await client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucketName,
          Delete: {
            Objects: batch.map((key) => ({ Key: key })),
            Quiet: true,
          },
        }),
      );

      // Log any failed deletions (Quiet mode still reports errors)
      if (response.Errors && response.Errors.length > 0) {
        const failedKeys = response.Errors.map(
          (err) => `${err.Key} (${err.Code}: ${err.Message})`,
        ).join(', ');
        getLogger().warn(
          `S3 deleteBatch: ${response.Errors.length} objects failed to delete: ${failedKeys}`,
        );
      }
    }
  }

  /**
   * Get the configured key prefix (useful for logging)
   */
  getKeyPrefix(): string {
    return this.keyPrefix;
  }

  /**
   * Ensure an S3 lifecycle rule exists for automatic object expiration.
   *
   * This method is **idempotent**: it reads existing lifecycle rules and only
   * adds or updates the langgraph-specific rule. User-defined rules on the
   * bucket are preserved.
   *
   * @param ttlDays - Expiration in days (S3 lifecycle uses day-level precision)
   * @throws Error if the S3 API calls fail (callers should catch gracefully)
   */
  async ensureLifecycleRule(ttlDays: number): Promise<void> {
    const { GetBucketLifecycleConfigurationCommand, PutBucketLifecycleConfigurationCommand } =
      getS3Sdk();
    const client = this.getClient();

    const ruleId = this.buildLifecycleRuleId();

    // 1. Read existing lifecycle configuration
    let existingRules: Array<{
      ID?: string;
      Filter?: Record<string, unknown>;
      Status?: string;
      Expiration?: Record<string, unknown>;
      [key: string]: unknown;
    }> = [];

    try {
      const existing = await client.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: this.bucketName }),
      );
      existingRules = (existing.Rules as typeof existingRules) ?? [];
    } catch (error: unknown) {
      // NoSuchLifecycleConfiguration means bucket has no lifecycle config — treat as empty
      if (
        error &&
        typeof error === 'object' &&
        'name' in error &&
        (error as { name: string }).name === 'NoSuchLifecycleConfiguration'
      ) {
        existingRules = [];
      } else {
        throw error;
      }
    }

    // 2. Check if a matching rule already exists (by ID)
    const existingRule = existingRules.find((r) => r.ID === ruleId);
    if (
      existingRule &&
      existingRule.Status === 'Enabled' &&
      existingRule.Expiration &&
      (existingRule.Expiration as { Days?: number }).Days === ttlDays
    ) {
      // Rule already exists with correct settings — nothing to do
      getLogger().info(
        `S3 lifecycle rule '${ruleId}' already exists with ${ttlDays}-day expiration — skipping`,
      );
      return;
    }

    // 3. Build the new rule
    const newRule = {
      ID: ruleId,
      Filter: { Prefix: this.keyPrefix },
      Status: 'Enabled' as const,
      Expiration: { Days: ttlDays },
    };

    // 4. Merge: replace existing rule with same ID or append
    const mergedRules = existingRule
      ? existingRules.map((r) => (r.ID === ruleId ? newRule : r))
      : [...existingRules, newRule];

    // 5. Write back
    await client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: this.bucketName,
        LifecycleConfiguration: {
          Rules: mergedRules as unknown as import('@aws-sdk/client-s3').LifecycleRule[],
        },
      }),
    );

    getLogger().info(
      `S3 lifecycle rule '${ruleId}' configured: ${ttlDays}-day expiration on prefix '${this.keyPrefix}'`,
    );
  }

  /**
   * Generate a deterministic lifecycle rule ID for idempotency.
   *
   * The ID is scoped to the configured key prefix but intentionally TTL-independent:
   * changing ttlDays updates the existing rule in place instead of leaving a stale
   * rule behind that would still expire objects at the old cadence.
   *
   * @returns Rule ID string
   */
  private buildLifecycleRuleId(): string {
    // Normalize the prefix into a lifecycle-rule-safe slug, trimming the trailing slash.
    const slug = this.keyPrefix.replace(/\/+$/, '').replace(/[^a-zA-Z0-9-]/g, '-') || 'default';
    return `langgraph-ttl-${slug}`;
  }

  /**
   * Release underlying S3 client resources
   */
  destroy(): void {
    this.s3Client?.destroy();
  }
}
