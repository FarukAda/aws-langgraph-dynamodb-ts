/**
 * Unit tests for src/shared/utils/s3-offloader.ts.
 *
 * Pinned against real source:
 *  - S3OffloadConfig fields: bucketName (required), keyPrefix?, thresholdBytes?,
 *    serverSideEncryption? (default 'AES256'), sseKmsKeyId?, clientConfig?.
 *  - DEFAULT_THRESHOLD_BYTES = 350 * 1024; shouldOffload(data) === data.length >= thresholdBytes
 *    (so a payload exactly AT the threshold IS offloaded — '>=' boundary).
 *  - buildKey(threadId, checkpointId, field) === `${keyPrefix}${threadId}/${checkpointId}/${field}.bin`.
 *  - upload(key, data) issues PutObjectCommand { Bucket, Key, Body, ContentType:
 *    'application/octet-stream', ServerSideEncryption } and returns the key.
 *  - download(key) issues GetObjectCommand { Bucket, Key }; round-trips the body
 *    via transformToByteArray; throws 'S3 object body is empty for key: <key>'
 *    when Body is missing.
 *
 * Seam (REQ-47 / AC-38): an injectable `createS3Client?: (cfg) => S3Client` on
 * S3OffloadConfig. The AWS-call tests inject the strict S3 mock through that
 * seam; the seam is NOT yet present on S3OffloadConfig so those cases are
 * EXPECTED to fail to compile until it lands. The pure-logic tests
 * (shouldOffload / buildKey / getKeyPrefix) reference the current real surface
 * and must pass.
 *
 * S3 mocked via aws-sdk-client-mock only (REQ-2).
 */
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { S3Offloader, type S3OffloadConfig } from '../../../../src/shared/utils/s3-offloader';
import { captureLogger } from '../../../shared/helpers/logger-capture';
import {
  createStrictS3Mock,
  s3DeleteObjectsWithErrors,
  s3GetObject404,
  s3PutObject5xx,
} from '../../../shared/mocks/s3';

const BUCKET = 'offload-bucket';
const DEFAULT_THRESHOLD_BYTES = 350 * 1024;

/** Build a config carrying the createS3Client seam (SEAM REQ-47 — not yet on the type). */
function makeConfig(
  createS3Client: () => S3Client,
  overrides: Partial<S3OffloadConfig> = {},
): S3OffloadConfig {
  return {
    bucketName: BUCKET,
    ...overrides,
    // SEAM (REQ-47): not yet a field on S3OffloadConfig — expected to fail to compile until added.
    createS3Client,
  } as S3OffloadConfig & { createS3Client: () => S3Client };
}

describe('s3-offloader: shouldOffload threshold (>=) off-by-one', () => {
  it('offloads a payload whose size is exactly AT the threshold (>= boundary, positive)', () => {
    const offloader = new S3Offloader({ bucketName: BUCKET, thresholdBytes: 1024 });

    expect(offloader.shouldOffload(new Uint8Array(1024))).toBe(true);
  }); // AC-30

  it('does NOT offload a payload one byte under the threshold (negative)', () => {
    const offloader = new S3Offloader({ bucketName: BUCKET, thresholdBytes: 1024 });

    expect(offloader.shouldOffload(new Uint8Array(1023))).toBe(false);
  }); // AC-30

  it('uses the 350KB default threshold when thresholdBytes is omitted', () => {
    const offloader = new S3Offloader({ bucketName: BUCKET });

    expect(offloader.shouldOffload(new Uint8Array(DEFAULT_THRESHOLD_BYTES))).toBe(true);
    expect(offloader.shouldOffload(new Uint8Array(DEFAULT_THRESHOLD_BYTES - 1))).toBe(false);
  }); // AC-30
});

describe('s3-offloader: key building', () => {
  it('builds a fully-qualified key from the default prefix, thread, checkpoint and field', () => {
    const offloader = new S3Offloader({ bucketName: BUCKET });

    expect(offloader.getKeyPrefix()).toBe('langgraph-checkpoints/');
    expect(offloader.buildKey('thread-1', 'ckpt-2', 'checkpoint')).toBe(
      'langgraph-checkpoints/thread-1/ckpt-2/checkpoint.bin',
    );
  }); // AC-30

  it('honors a custom keyPrefix in both getKeyPrefix and buildKey (negative: not the default)', () => {
    const offloader = new S3Offloader({ bucketName: BUCKET, keyPrefix: 'custom/' });

    expect(offloader.getKeyPrefix()).toBe('custom/');
    expect(offloader.buildKey('t', 'c', 'metadata')).toBe('custom/t/c/metadata.bin');
  }); // AC-30
});

describe('s3-offloader: upload/download round-trip via injected S3 client', () => {
  it('upload issues an exact PutObjectCommand and download round-trips the same bytes (AC-15 codec)', async () => {
    const s3 = createStrictS3Mock();
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    s3.mock.on(PutObjectCommand).resolves({});
    s3.mock.on(GetObjectCommand).resolves({
      Body: {
        transformToByteArray: async (): Promise<Uint8Array> => payload,
      },
    } as never);

    const offloader = new S3Offloader(makeConfig(s3.createS3Client));
    const key = offloader.buildKey('t', 'c', 'checkpoint');

    const returnedKey = await offloader.upload(key, payload);
    const downloaded = await offloader.download(key);

    expect(returnedKey).toBe(key);
    const putCalls = s3.mock.commandCalls(PutObjectCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].args[0]).toBeInstanceOf(PutObjectCommand);
    expect(putCalls[0].args[0].input).toEqual({
      Bucket: BUCKET,
      Key: key,
      Body: payload,
      ContentType: 'application/octet-stream',
      ServerSideEncryption: 'AES256',
    });
    const getCalls = s3.mock.commandCalls(GetObjectCommand);
    expect(getCalls).toHaveLength(1);
    expect(getCalls[0].args[0].input).toEqual({ Bucket: BUCKET, Key: key });
    expect(downloaded).toEqual(payload);
    s3.reset();
  }); // AC-15
});

describe('s3-offloader: failure paths', () => {
  it('propagates a PutObject 5xx so the caller never persists a pointer (no half-written reference)', async () => {
    const s3 = createStrictS3Mock();
    s3PutObject5xx(s3.mock);
    const offloader = new S3Offloader(makeConfig(s3.createS3Client));
    const key = offloader.buildKey('t', 'c', 'checkpoint');

    await expect(offloader.upload(key, new Uint8Array([9]))).rejects.toThrow(/internal error/i);
    expect(s3.mock.commandCalls(PutObjectCommand)).toHaveLength(1);
    s3.reset();
  }); // AC-30

  it('surfaces a GetObject 404 NoSuchKey when downloading a dangling pointer reference', async () => {
    const s3 = createStrictS3Mock();
    s3GetObject404(s3.mock);
    const offloader = new S3Offloader(makeConfig(s3.createS3Client));

    await expect(offloader.download('missing-key')).rejects.toThrow(/does not exist/i);
    expect(s3.mock.commandCalls(GetObjectCommand)).toHaveLength(1);
    s3.reset();
  }); // AC-30

  it('throws the documented empty-body error when GetObject returns a response with no Body', async () => {
    const s3 = createStrictS3Mock();
    s3.mock.on(GetObjectCommand).resolves({});
    const offloader = new S3Offloader(makeConfig(s3.createS3Client));

    await expect(offloader.download('empty-key')).rejects.toThrow(
      'S3 object body is empty for key: empty-key',
    );
    s3.reset();
  }); // AC-30
});

describe('s3-offloader: server-side encryption / KMS', () => {
  it('adds SSEKMSKeyId to the PutObject input when serverSideEncryption is aws:kms', async () => {
    const s3 = createStrictS3Mock();
    s3.mock.on(PutObjectCommand).resolves({});
    const offloader = new S3Offloader(
      makeConfig(s3.createS3Client, {
        serverSideEncryption: 'aws:kms',
        sseKmsKeyId: 'arn:aws:kms:us-east-1:111122223333:key/abc',
      }),
    );

    await offloader.upload('k', new Uint8Array([1]));

    const putCalls = s3.mock.commandCalls(PutObjectCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].args[0].input).toEqual({
      Bucket: BUCKET,
      Key: 'k',
      Body: new Uint8Array([1]),
      ContentType: 'application/octet-stream',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: 'arn:aws:kms:us-east-1:111122223333:key/abc',
    });
    s3.reset();
  }); // AC-30
});

describe('s3-offloader: delete single object', () => {
  it('issues an exact DeleteObjectCommand for the given key', async () => {
    const s3 = createStrictS3Mock();
    s3.mock.on(DeleteObjectCommand).resolves({});
    const offloader = new S3Offloader(makeConfig(s3.createS3Client));

    await offloader.delete('langgraph-checkpoints/t/c/checkpoint.bin');

    const calls = s3.mock.commandCalls(DeleteObjectCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0]).toBeInstanceOf(DeleteObjectCommand);
    expect(calls[0].args[0].input).toEqual({
      Bucket: BUCKET,
      Key: 'langgraph-checkpoints/t/c/checkpoint.bin',
    });
    s3.reset();
  }); // AC-30

  it('propagates a delete failure so callers can surface the error', async () => {
    const s3 = createStrictS3Mock();
    s3.mock.on(DeleteObjectCommand).rejects(new Error('AccessDenied'));
    const offloader = new S3Offloader(makeConfig(s3.createS3Client));

    await expect(offloader.delete('k')).rejects.toThrow(/AccessDenied/);
    s3.reset();
  }); // AC-30
});

describe('s3-offloader: deleteBatch', () => {
  it('returns immediately without an S3 call for an empty key list (no-op short-circuit)', async () => {
    const s3 = createStrictS3Mock();
    const offloader = new S3Offloader(makeConfig(s3.createS3Client));

    await offloader.deleteBatch([]);

    expect(s3.mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
    s3.reset();
  }); // AC-30

  it('issues a single quiet DeleteObjectsCommand for a small batch of keys', async () => {
    const s3 = createStrictS3Mock();
    s3.mock.on(DeleteObjectsCommand).resolves({ Deleted: [], Errors: [] });
    const offloader = new S3Offloader(makeConfig(s3.createS3Client));

    await offloader.deleteBatch(['a', 'b', 'c']);

    const calls = s3.mock.commandCalls(DeleteObjectsCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toEqual({
      Bucket: BUCKET,
      Delete: {
        Objects: [{ Key: 'a' }, { Key: 'b' }, { Key: 'c' }],
        Quiet: true,
      },
    });
    s3.reset();
  }); // AC-30

  it('issues EXACTLY one DeleteObjects request for exactly 1000 keys (kills i<=length loop mutant)', async () => {
    // The S3 per-request cap is 1000. With `i <= keys.length` the loop runs an
    // extra iteration on a 1000-key (multiple-of-batchSize) input and sends a
    // second DeleteObjects with an empty Objects array. The original sends one.
    const s3 = createStrictS3Mock();
    s3.mock.on(DeleteObjectsCommand).resolves({ Deleted: [], Errors: [] });
    const offloader = new S3Offloader(makeConfig(s3.createS3Client));
    const keys = Array.from({ length: 1000 }, (_, i) => `key-${i}`);

    await offloader.deleteBatch(keys);

    const calls = s3.mock.commandCalls(DeleteObjectsCommand);
    expect(calls).toHaveLength(1);
    expect((calls[0].args[0].input.Delete?.Objects ?? []).length).toBe(1000);
    s3.reset();
  }); // AC-30

  it('does NOT log a warning when DeleteObjects reports zero per-key Errors (kills length>0 -> true / >=0 mutants)', async () => {
    // Mutating `response.Errors.length > 0` to `true` or `>= 0` would emit a
    // bogus "0 objects failed" warning on the all-success path. Assert silence.
    const s3 = createStrictS3Mock();
    s3.mock.on(DeleteObjectsCommand).resolves({ Deleted: [{ Key: 'a' }], Errors: [] });
    const cap = captureLogger();
    const offloader = new S3Offloader(makeConfig(s3.createS3Client));

    await offloader.deleteBatch(['a']);

    expect(cap.entries.filter((e) => e.level === 'warn')).toHaveLength(0);
    cap.restore();
    s3.reset();
  }); // AC-34

  it('chunks more than 1000 keys into multiple DeleteObjects requests (S3 per-request cap)', async () => {
    const s3 = createStrictS3Mock();
    s3.mock.on(DeleteObjectsCommand).resolves({ Deleted: [], Errors: [] });
    const offloader = new S3Offloader(makeConfig(s3.createS3Client));
    const keys = Array.from({ length: 1001 }, (_, i) => `key-${i}`);

    await offloader.deleteBatch(keys);

    const calls = s3.mock.commandCalls(DeleteObjectsCommand);
    expect(calls).toHaveLength(2);
    expect((calls[0].args[0].input.Delete?.Objects ?? []).length).toBe(1000);
    expect((calls[1].args[0].input.Delete?.Objects ?? []).length).toBe(1);
    s3.reset();
  }); // AC-30

  it('logs a warning listing the failed keys when DeleteObjects reports per-key Errors', async () => {
    const s3 = createStrictS3Mock();
    s3DeleteObjectsWithErrors(s3.mock, ['bad-1', 'bad-2']);
    const cap = captureLogger();
    const offloader = new S3Offloader(makeConfig(s3.createS3Client));

    await offloader.deleteBatch(['bad-1', 'bad-2']);

    const warns = cap.entries.filter((e) => e.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain('S3 deleteBatch: 2 objects failed to delete');
    expect(warns[0].message).toContain('bad-1 (InternalError: failed)');
    expect(warns[0].message).toContain('bad-2 (InternalError: failed)');
    // The two failed-key descriptions are joined by ", " — a join("") mutant
    // would collapse them to "...failed)bad-2...". Pin the exact full message.
    expect(warns[0].message).toBe(
      'S3 deleteBatch: 2 objects failed to delete: ' +
        'bad-1 (InternalError: failed), bad-2 (InternalError: failed)',
    );
    cap.restore();
    s3.reset();
  }); // AC-34
});

describe('s3-offloader: ensureLifecycleRule', () => {
  it('creates a new rule when the bucket has NO lifecycle config (NoSuchLifecycleConfiguration treated as empty)', async () => {
    const s3 = createStrictS3Mock();
    const noConfig = Object.assign(new Error('no lifecycle'), {
      name: 'NoSuchLifecycleConfiguration',
    });
    s3.mock.on(GetBucketLifecycleConfigurationCommand).rejects(noConfig);
    s3.mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    const cap = captureLogger();
    const offloader = new S3Offloader(makeConfig(s3.createS3Client));

    await offloader.ensureLifecycleRule(30);

    const puts = s3.mock.commandCalls(PutBucketLifecycleConfigurationCommand);
    expect(puts).toHaveLength(1);
    expect(puts[0].args[0].input).toEqual({
      Bucket: BUCKET,
      LifecycleConfiguration: {
        Rules: [
          {
            ID: 'langgraph-ttl-langgraph-checkpoints',
            Filter: { Prefix: 'langgraph-checkpoints/' },
            Status: 'Enabled',
            Expiration: { Days: 30 },
          },
        ],
      },
    });
    cap.restore();
    s3.reset();
  }); // AC-34

  it('is a no-op (no PutBucketLifecycleConfiguration) when a matching enabled rule with the same Days already exists', async () => {
    const s3 = createStrictS3Mock();
    s3.mock.on(GetBucketLifecycleConfigurationCommand).resolves({
      Rules: [
        {
          ID: 'langgraph-ttl-langgraph-checkpoints',
          Filter: { Prefix: 'langgraph-checkpoints/' },
          Status: 'Enabled',
          Expiration: { Days: 30 },
        },
      ],
    } as never);
    const cap = captureLogger();
    const offloader = new S3Offloader(makeConfig(s3.createS3Client));

    await offloader.ensureLifecycleRule(30);

    expect(s3.mock.commandCalls(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
    const infos = cap.entries.filter((e) => e.level === 'info');
    expect(infos.some((e) => e.message.includes('already exists'))).toBe(true);
    cap.restore();
    s3.reset();
  }); // AC-34

  it('updates an existing rule in place when its Days differ (preserving other user rules)', async () => {
    const s3 = createStrictS3Mock();
    s3.mock.on(GetBucketLifecycleConfigurationCommand).resolves({
      Rules: [
        {
          ID: 'user-rule',
          Filter: { Prefix: 'other/' },
          Status: 'Enabled',
          Expiration: { Days: 7 },
        },
        {
          ID: 'langgraph-ttl-langgraph-checkpoints',
          Filter: { Prefix: 'langgraph-checkpoints/' },
          Status: 'Enabled',
          Expiration: { Days: 10 },
        },
      ],
    } as never);
    s3.mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    const offloader = new S3Offloader(makeConfig(s3.createS3Client));

    await offloader.ensureLifecycleRule(30);

    const puts = s3.mock.commandCalls(PutBucketLifecycleConfigurationCommand);
    expect(puts).toHaveLength(1);
    const rules = puts[0].args[0].input.LifecycleConfiguration?.Rules ?? [];
    // User rule preserved untouched; langgraph rule's Days replaced with 30.
    expect(rules).toEqual([
      { ID: 'user-rule', Filter: { Prefix: 'other/' }, Status: 'Enabled', Expiration: { Days: 7 } },
      {
        ID: 'langgraph-ttl-langgraph-checkpoints',
        Filter: { Prefix: 'langgraph-checkpoints/' },
        Status: 'Enabled',
        Expiration: { Days: 30 },
      },
    ]);
    s3.reset();
  }); // AC-34

  it('appends the langgraph rule when only unrelated user rules exist', async () => {
    const s3 = createStrictS3Mock();
    s3.mock.on(GetBucketLifecycleConfigurationCommand).resolves({
      Rules: [
        {
          ID: 'user-rule',
          Filter: { Prefix: 'other/' },
          Status: 'Enabled',
          Expiration: { Days: 7 },
        },
      ],
    } as never);
    s3.mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    const offloader = new S3Offloader(makeConfig(s3.createS3Client));

    await offloader.ensureLifecycleRule(45);

    const puts = s3.mock.commandCalls(PutBucketLifecycleConfigurationCommand);
    const rules = puts[0].args[0].input.LifecycleConfiguration?.Rules ?? [];
    expect(rules).toHaveLength(2);
    expect(rules[1]).toEqual({
      ID: 'langgraph-ttl-langgraph-checkpoints',
      Filter: { Prefix: 'langgraph-checkpoints/' },
      Status: 'Enabled',
      Expiration: { Days: 45 },
    });
    s3.reset();
  }); // AC-34

  it('re-throws non-NoSuchLifecycleConfiguration GetBucketLifecycle errors instead of swallowing them', async () => {
    const s3 = createStrictS3Mock();
    const accessDenied = Object.assign(new Error('forbidden'), { name: 'AccessDenied' });
    s3.mock.on(GetBucketLifecycleConfigurationCommand).rejects(accessDenied);
    const offloader = new S3Offloader(makeConfig(s3.createS3Client));

    await expect(offloader.ensureLifecycleRule(30)).rejects.toThrow(/forbidden/);
    expect(s3.mock.commandCalls(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
    s3.reset();
  }); // AC-34

  it('treats a missing Rules field on the GetBucket response as empty (?? [] coalesces, no phantom rule)', async () => {
    // GetBucketLifecycle returns a response with NO Rules property. The `?? []`
    // coalesces to an empty list, so the merged write contains exactly the one
    // new langgraph rule. A non-empty default would carry a junk
    // pre-existing rule into the merge, producing two rules.
    const s3 = createStrictS3Mock();
    s3.mock.on(GetBucketLifecycleConfigurationCommand).resolves({} as never);
    s3.mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    const offloader = new S3Offloader(makeConfig(s3.createS3Client));

    await offloader.ensureLifecycleRule(20);

    const puts = s3.mock.commandCalls(PutBucketLifecycleConfigurationCommand);
    const rules = puts[0].args[0].input.LifecycleConfiguration?.Rules ?? [];
    expect(rules).toEqual([
      {
        ID: 'langgraph-ttl-langgraph-checkpoints',
        Filter: { Prefix: 'langgraph-checkpoints/' },
        Status: 'Enabled',
        Expiration: { Days: 20 },
      },
    ]);
    s3.reset();
  }); // AC-34

  it('rebuilds (does NOT no-op) when an existing same-Days rule is DISABLED (kills Status === "Enabled" -> true mutant)', async () => {
    // The no-op branch requires Status === 'Enabled'. A rule with matching ID and
    // Days but Status 'Disabled' must NOT short-circuit — the rule is re-written
    // as Enabled. The `true` mutant would skip the Put.
    const s3 = createStrictS3Mock();
    s3.mock.on(GetBucketLifecycleConfigurationCommand).resolves({
      Rules: [
        {
          ID: 'langgraph-ttl-langgraph-checkpoints',
          Filter: { Prefix: 'langgraph-checkpoints/' },
          Status: 'Disabled',
          Expiration: { Days: 30 },
        },
      ],
    } as never);
    s3.mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    const offloader = new S3Offloader(makeConfig(s3.createS3Client));

    await offloader.ensureLifecycleRule(30);

    const puts = s3.mock.commandCalls(PutBucketLifecycleConfigurationCommand);
    expect(puts).toHaveLength(1);
    const rules = puts[0].args[0].input.LifecycleConfiguration?.Rules ?? [];
    expect(rules).toEqual([
      {
        ID: 'langgraph-ttl-langgraph-checkpoints',
        Filter: { Prefix: 'langgraph-checkpoints/' },
        Status: 'Enabled',
        Expiration: { Days: 30 },
      },
    ]);
    s3.reset();
  }); // AC-34

  it('logs the exact configured-rule info message after writing a new rule (kills empty-string log mutant on line 361)', async () => {
    const s3 = createStrictS3Mock();
    s3.mock.on(GetBucketLifecycleConfigurationCommand).resolves({ Rules: [] } as never);
    s3.mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    const cap = captureLogger();
    const offloader = new S3Offloader(makeConfig(s3.createS3Client));

    await offloader.ensureLifecycleRule(30);

    const infos = cap.entries.filter((e) => e.level === 'info');
    expect(
      infos.some(
        (e) =>
          e.message ===
          "S3 lifecycle rule 'langgraph-ttl-langgraph-checkpoints' configured: " +
            "30-day expiration on prefix 'langgraph-checkpoints/'",
      ),
    ).toBe(true);
    cap.restore();
    s3.reset();
  }); // AC-34

  it('falls back to the "default" slug when the prefix sanitizes to empty (kills || "" mutant on line 376)', async () => {
    // keyPrefix '/' trims to '' then sanitizes to '' -> `|| 'default'` yields
    // 'default'. A `|| ""` mutant would emit ID 'langgraph-ttl-' instead.
    const s3 = createStrictS3Mock();
    s3.mock.on(GetBucketLifecycleConfigurationCommand).resolves({ Rules: [] } as never);
    s3.mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    const offloader = new S3Offloader(makeConfig(s3.createS3Client, { keyPrefix: '/' }));

    await offloader.ensureLifecycleRule(15);

    const puts = s3.mock.commandCalls(PutBucketLifecycleConfigurationCommand);
    const rules = puts[0].args[0].input.LifecycleConfiguration?.Rules ?? [];
    expect((rules[0] as { ID?: string }).ID).toBe('langgraph-ttl-default');
    s3.reset();
  }); // AC-34

  it('trims ALL trailing slashes from the prefix slug (kills /\\/+$/ -> /\\/$/ regex mutant)', async () => {
    // keyPrefix 'pre//' -> the `/\/+$/` (one-or-more) trim removes BOTH slashes
    // -> 'pre'. A `/\/$/` mutant removes only the last slash, leaving 'pre/'
    // which then sanitizes to 'pre-'. Assert the fully-trimmed slug.
    const s3 = createStrictS3Mock();
    s3.mock.on(GetBucketLifecycleConfigurationCommand).resolves({ Rules: [] } as never);
    s3.mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    const offloader = new S3Offloader(makeConfig(s3.createS3Client, { keyPrefix: 'pre//' }));

    await offloader.ensureLifecycleRule(15);

    const puts = s3.mock.commandCalls(PutBucketLifecycleConfigurationCommand);
    const rules = puts[0].args[0].input.LifecycleConfiguration?.Rules ?? [];
    expect((rules[0] as { ID?: string }).ID).toBe('langgraph-ttl-pre');
    s3.reset();
  }); // AC-34

  it('derives a sanitized, slash-trimmed rule ID slug from a custom keyPrefix', async () => {
    const s3 = createStrictS3Mock();
    s3.mock.on(GetBucketLifecycleConfigurationCommand).resolves({ Rules: [] } as never);
    s3.mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    const offloader = new S3Offloader(
      makeConfig(s3.createS3Client, { keyPrefix: 'my_prefix/sub/' }),
    );

    await offloader.ensureLifecycleRule(15);

    const puts = s3.mock.commandCalls(PutBucketLifecycleConfigurationCommand);
    const rules = puts[0].args[0].input.LifecycleConfiguration?.Rules ?? [];
    // '/' and '_' become '-', trailing slash trimmed: 'my_prefix/sub/' -> 'my-prefix-sub'.
    expect((rules[0] as { ID?: string }).ID).toBe('langgraph-ttl-my-prefix-sub');
    s3.reset();
  }); // AC-34
});

describe('s3-offloader: destroy', () => {
  it('calls destroy() on the lazily-created S3 client', async () => {
    const s3 = createStrictS3Mock();
    s3.mock.on(PutObjectCommand).resolves({});
    // Spy on the real S3Client prototype: the offloader constructs `new S3Client()`
    // internally (aws-sdk-client-mock only intercepts `send`), so destroy()
    // delegates to the genuine prototype method on the live instance.
    const destroySpy = jest
      .spyOn(S3Client.prototype, 'destroy')
      .mockImplementation(() => undefined);
    const offloader = new S3Offloader(makeConfig(s3.createS3Client));
    // Force lazy client creation via an upload, then assert destroy delegates.
    await offloader.upload('k', new Uint8Array([1]));

    offloader.destroy();

    expect(destroySpy).toHaveBeenCalledTimes(1);
    destroySpy.mockRestore();
    s3.reset();
  }); // AC-30

  it('lazily creates the S3 client exactly once and reuses it (kills !this.s3Client -> true caching mutant)', async () => {
    // getClient() caches on first use. With `if (true)` the client would be
    // rebuilt on every send, so the factory would be invoked more than once
    // across two uploads. Count factory invocations through the seam.
    const s3 = createStrictS3Mock();
    s3.mock.on(PutObjectCommand).resolves({});
    let factoryCalls = 0;
    const countingFactory = (): S3Client => {
      factoryCalls += 1;
      return s3.createS3Client();
    };
    const offloader = new S3Offloader(makeConfig(countingFactory));

    await offloader.upload('k1', new Uint8Array([1]));
    await offloader.upload('k2', new Uint8Array([2]));

    expect(factoryCalls).toBe(1);
    expect(s3.mock.commandCalls(PutObjectCommand)).toHaveLength(2);
    s3.reset();
  }); // AC-30

  it('is a safe no-op when destroy() is called before any S3 client was created', () => {
    const s3 = createStrictS3Mock();
    const offloader = new S3Offloader(makeConfig(s3.createS3Client));

    expect(() => offloader.destroy()).not.toThrow();
    s3.reset();
  }); // AC-30
});
