/**
 * Unit tests for src/shared/utils/s3-orphans.ts.
 *
 * Pinned against real source:
 *  - The ONLY export is:
 *      cleanUpS3Orphans(offloader: S3Offloader, keys: ReadonlyArray<string | undefined>, context: string): Promise<void>
 *    (there is no `detectS3Orphans`, no DDB/BatchGet, and no ListObjectsV2 in this module.)
 *  - It filters keys to truthy non-empty strings; if none remain it returns
 *    without calling S3 (no DeleteObjects).
 *  - It calls `offloader.deleteBatch(orphans)` which issues a single
 *    DeleteObjectsCommand with input { Bucket, Delete: { Objects: [{Key}...], Quiet: true } }.
 *  - On a TRANSIENT S3 error (500/503/429, SlowDown, InternalError, ECONNRESET, ...)
 *    it retries up to ORPHAN_CLEANUP_MAX_ATTEMPTS (3) with full-jitter backoff,
 *    then logs a warn (it never re-throws — best-effort cleanup).
 *  - On a NON-transient error it breaks immediately (single attempt) and logs warn.
 *
 * S3 is exercised through a real S3Offloader whose underlying client is the
 * strict S3 mock injected via the createS3Client seam (REQ-47 — not yet present
 * on S3OffloadConfig, so the offloader construction is EXPECTED to fail to
 * compile until that seam lands). S3 mocked via aws-sdk-client-mock only (REQ-2).
 */
import { DeleteObjectsCommand, type S3Client } from '@aws-sdk/client-s3';

import { S3Offloader, type S3OffloadConfig } from '../../../../src/shared/utils/s3-offloader';
import { cleanUpS3Orphans } from '../../../../src/shared/utils/s3-orphans';
import { captureLogger } from '../../../shared/helpers/logger-capture';
import { createStrictS3Mock } from '../../../shared/mocks/s3';

const BUCKET = 'offload-bucket';

function makeOffloader(createS3Client: () => S3Client): S3Offloader {
  return new S3Offloader({
    bucketName: BUCKET,
    // SEAM (REQ-47): not yet a field on S3OffloadConfig — expected to fail to compile until added.
    createS3Client,
  } as S3OffloadConfig & { createS3Client: () => S3Client });
}

/** Drive a promise to completion while flushing fake timers (retry backoff sleeps). */
async function runWithTimerDrain<T>(p: Promise<T>): Promise<T> {
  let settled = false;
  const wrapped = p.finally(() => {
    settled = true;
  });
  while (!settled) {
    await Promise.resolve();
    jest.advanceTimersByTime(10_000);
  }
  return wrapped;
}

describe('s3-orphans: cleanUpS3Orphans', () => {
  it('issues a single DeleteObjectsCommand with the exact { Objects, Quiet: true } shape for the orphan keys', async () => {
    const s3 = createStrictS3Mock();
    s3.mock.on(DeleteObjectsCommand).resolves({ Deleted: [{ Key: 'orphan-key' }], Errors: [] });
    const offloader = makeOffloader(s3.createS3Client);

    await cleanUpS3Orphans(offloader, ['orphan-key'], 'put-writes');

    const calls = s3.mock.commandCalls(DeleteObjectsCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0]).toBeInstanceOf(DeleteObjectsCommand);
    expect(calls[0].args[0].input).toEqual({
      Bucket: BUCKET,
      Delete: { Objects: [{ Key: 'orphan-key' }], Quiet: true },
    });
    s3.reset();
  }); // AC-30

  it('issues no S3 command when every key is undefined or empty (negative — nothing to clean)', async () => {
    const s3 = createStrictS3Mock();
    const offloader = makeOffloader(s3.createS3Client);

    await cleanUpS3Orphans(offloader, [undefined, '', undefined], 'put');

    expect(s3.mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
    s3.reset();
  }); // AC-30

  it('filters out undefined/empty keys and deletes only the real keys in one batch', async () => {
    const s3 = createStrictS3Mock();
    s3.mock.on(DeleteObjectsCommand).resolves({ Deleted: [], Errors: [] });
    const offloader = makeOffloader(s3.createS3Client);

    await cleanUpS3Orphans(offloader, [undefined, 'k1', '', 'k2'], 'put');

    const calls = s3.mock.commandCalls(DeleteObjectsCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toEqual({
      Bucket: BUCKET,
      Delete: { Objects: [{ Key: 'k1' }, { Key: 'k2' }], Quiet: true },
    });
    s3.reset();
  }); // AC-30

  it('retries a transient 500 up to 3 attempts then swallows the failure and logs a warn naming the context', async () => {
    jest.useFakeTimers();
    const capture = captureLogger();
    try {
      const s3 = createStrictS3Mock();
      const transient = Object.assign(new Error('We encountered an internal error.'), {
        name: 'InternalError',
        $metadata: { httpStatusCode: 500 },
      });
      s3.mock.on(DeleteObjectsCommand).rejects(transient);
      const offloader = makeOffloader(s3.createS3Client);

      // Best-effort: must resolve (never re-throw) even when all attempts fail.
      await runWithTimerDrain(cleanUpS3Orphans(offloader, ['orphan-key'], 'put-writes'));

      // ORPHAN_CLEANUP_MAX_ATTEMPTS === 3 transient attempts.
      expect(s3.mock.commandCalls(DeleteObjectsCommand)).toHaveLength(3);
      const warns = capture.entries.filter((e) => e.level === 'warn');
      expect(warns).toHaveLength(1);
      expect(warns[0].message).toContain('put-writes');
      expect(warns[0].message).toContain('3 attempts');
    } finally {
      capture.restore();
      jest.useRealTimers();
    }
  }); // AC-19

  it('does not retry a non-transient error: a single attempt then a swallowed warn', async () => {
    const capture = captureLogger();
    try {
      const s3 = createStrictS3Mock();
      const permanent = Object.assign(new Error('Access Denied'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      });
      s3.mock.on(DeleteObjectsCommand).rejects(permanent);
      const offloader = makeOffloader(s3.createS3Client);

      await cleanUpS3Orphans(offloader, ['orphan-key'], 'put');

      // Non-transient -> break after the first attempt, no retries.
      expect(s3.mock.commandCalls(DeleteObjectsCommand)).toHaveLength(1);
      const warns = capture.entries.filter((e) => e.level === 'warn');
      expect(warns).toHaveLength(1);
      expect(warns[0].message).toContain('Access Denied');
    } finally {
      capture.restore();
    }
  }); // AC-19
});
