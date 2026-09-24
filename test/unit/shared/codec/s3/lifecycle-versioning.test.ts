import { GetBucketVersioningCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';

import { reportBucketVersioning } from '../../../../../src/shared/codec/s3/lifecycle';
import { MAX_LOGGED_VALUE_CHARS, truncateForLog } from '../../../../../src/shared/logging/truncate';

const s3Mock = mockClient(S3Client);

afterEach(() => s3Mock.reset());

function fakeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function client(): S3Client {
  return new S3Client({ region: 'us-east-1' });
}

/** The one warning this call emitted; fails when it emitted none or several. */
function warning(logger: ReturnType<typeof fakeLogger>): [string, object] {
  expect(logger.warn).toHaveBeenCalledTimes(1);
  return logger.warn.mock.calls[0] as [string, object];
}

describe('reportBucketVersioning', () => {
  /** Versioning on is the state the containment layer needs; there is nothing to say. */
  it('says nothing about a versioned bucket', async () => {
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
    const logger = fakeLogger();
    await reportBucketVersioning(client(), 'b', logger);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  /**
   * A bucket that has never been versioned answers with an empty body, so the
   * absent state is `Status === undefined` — never `'Disabled'`, which this
   * API does not return.
   */
  it('tells an operator to enable versioning when the bucket reports none', async () => {
    s3Mock.on(GetBucketVersioningCommand).resolves({});
    const logger = fakeLogger();
    await reportBucketVersioning(client(), 'b', logger);
    const [message, fields] = warning(logger);
    expect(message).toContain('versioning is off');
    expect(message).toContain('enable bucket versioning');
    expect(fields).toEqual({ bucket: 'b' });
  });

  /**
   * Suspension is not the same remedy: re-enabling it restores the containment
   * from here on, and nothing restores the releases made while it was in force.
   * Collapsing this into the state above loses that second half.
   */
  it('tells an operator to re-enable versioning, and what suspension already cost', async () => {
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Suspended' });
    const logger = fakeLogger();
    await reportBucketVersioning(client(), 'b', logger);
    const [message, fields] = warning(logger);
    expect(message).toContain('versioning is suspended');
    expect(message).toContain('re-enable versioning');
    expect(message).toContain('already gone');
    expect(fields).toEqual({ bucket: 'b' });
  });

  it('distinguishes the absent state from the suspended one', async () => {
    s3Mock.on(GetBucketVersioningCommand).resolves({});
    const off = fakeLogger();
    await reportBucketVersioning(client(), 'b', off);
    s3Mock.reset();
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Suspended' });
    const suspended = fakeLogger();
    await reportBucketVersioning(client(), 'b', suspended);
    expect(warning(off)[0]).not.toBe(warning(suspended)[0]);
  });

  /**
   * A role that provisioned lifecycle rules yesterday does not carry the
   * action this call needs, and must not start failing over it.
   */
  it('warns rather than throws when the call itself is refused', async () => {
    s3Mock
      .on(GetBucketVersioningCommand)
      .rejects(Object.assign(new Error('nope'), { name: 'AccessDenied' }));
    const logger = fakeLogger();
    await expect(reportBucketVersioning(client(), 'b', logger)).resolves.toBeUndefined();
    const [message, fields] = warning(logger);
    expect(message).toContain('could not read');
    expect(message).toContain('s3:GetBucketVersioning');
    expect(fields).toEqual({ bucket: 'b', reason: 'AccessDenied' });
  });

  /** A rejection from a client seam need not be an Error, and must not become one here. */
  it('falls back to a placeholder when the rejection carries no name', async () => {
    s3Mock.on(GetBucketVersioningCommand).callsFake(() => Promise.reject({ httpStatusCode: 500 }));
    const logger = fakeLogger();
    await expect(reportBucketVersioning(client(), 'b', logger)).resolves.toBeUndefined();
    expect(warning(logger)[1]).toEqual({ bucket: 'b', reason: 'unknown' });
  });

  it('warns rather than throwing when the rejection is not an object at all', async () => {
    s3Mock.on(GetBucketVersioningCommand).callsFake(() => Promise.reject(null));
    const logger = fakeLogger();
    await expect(reportBucketVersioning(client(), 'b', logger)).resolves.toBeUndefined();
    expect(warning(logger)[1]).toEqual({ bucket: 'b', reason: 'unknown' });
  });

  /** The error's name, never its message, which can carry credential text. */
  it('names the failure without repeating what it said', async () => {
    s3Mock
      .on(GetBucketVersioningCommand)
      .rejects(Object.assign(new Error('AKIAIOSFODNN7EXAMPLE is not authorized'), { name: 'X' }));
    const logger = fakeLogger();
    await reportBucketVersioning(client(), 'b', logger);
    const [message, fields] = warning(logger);
    expect(message).not.toContain('AKIA');
    expect(fields).toEqual({ bucket: 'b', reason: 'X' });
  });

  /**
   * `s3.bucketName` is checked for being a non-empty string and never for
   * length, and the name of whatever rejected is the SDK's or a client seam's.
   * Both are quoted here, so both are cut at the log cap and marked with what
   * they really held.
   */
  it('cuts the bucket it names and the reason beside it', async () => {
    const bucket = 'b'.repeat(MAX_LOGGED_VALUE_CHARS * 4);
    const reason = 'R'.repeat(MAX_LOGGED_VALUE_CHARS * 4);
    s3Mock
      .on(GetBucketVersioningCommand)
      .rejects(Object.assign(new Error('denied'), { name: reason }));
    const logger = fakeLogger();
    await reportBucketVersioning(client(), bucket, logger);
    expect(warning(logger)[1]).toEqual({
      bucket: truncateForLog(bucket),
      reason: truncateForLog(reason),
    });
  });

  /** The same bucket, cut the same way, on the line that reports versioning off. */
  it('cuts the bucket on the state lines too', async () => {
    const bucket = 'b'.repeat(MAX_LOGGED_VALUE_CHARS * 4);
    s3Mock.on(GetBucketVersioningCommand).resolves({});
    const off = fakeLogger();
    await reportBucketVersioning(client(), bucket, off);
    expect(warning(off)[1]).toEqual({ bucket: truncateForLog(bucket) });

    s3Mock.reset();
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Suspended' });
    const suspended = fakeLogger();
    await reportBucketVersioning(client(), bucket, suspended);
    expect(warning(suspended)[1]).toEqual({ bucket: truncateForLog(bucket) });
  });
});
