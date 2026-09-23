import { DeleteObjectsCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

import { DynamoDBSaver } from '../../../../../src/checkpointer/saver';
import { cleanUpS3Orphans } from '../../../../../src/shared/codec/s3/orphans';
import { ErrorCode } from '../../../../../src/shared/errors/error-code';
import type { Logger } from '../../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../../shared/helpers/ddb-mock';

const s3Mock = mockClient(S3Client);
afterEach(() => s3Mock.reset());

/**
 * A logger whose every level throws: a transport that has closed, a formatter
 * that meets a circular object, an assertion on a field it did not expect.
 * `Logger` is an interface a consumer implements, and the cleanup calls it from
 * inside the `catch` its own callers are standing in.
 */
function throwingLogger(): Logger & { warn: jest.Mock } {
  const fail = jest.fn((): never => {
    throw new Error('logger transport closed');
  });
  return { info: fail, warn: fail, error: fail, debug: fail };
}

/** A non-transient S3 failure, so the cleanup reports rather than retries. */
function accessDenied(): Error {
  return Object.assign(new Error('denied'), { name: 'AccessDenied' });
}

/**
 * `cleanUpS3Orphans` documents that it throws nothing, ever, and every call
 * site leans on that: most run it from a `catch`, on the way to rethrowing the
 * error the caller actually needs, and the rest promise never to throw
 * themselves. A logger that throws must be absorbed like every other cleanup
 * failure, or it silently becomes the error the caller sees.
 */
describe('cleanUpS3Orphans with a logger that throws', () => {
  it('absorbs the throw from the out-of-scope report', async () => {
    const offloader = { deleteBatch: jest.fn(), ownsKey: () => false };
    await expect(
      cleanUpS3Orphans(offloader as never, ['foreign/b.bin'], 'deleteThread', throwingLogger(), {
        scope: ['t'],
      }),
    ).resolves.toBeUndefined();
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
  });

  /**
   * This report sits inside the retry loop's own `catch`, so resolving proves
   * nothing on its own: an unguarded throw here is caught there, read as a
   * failed delete, and answered with the second report below. The call count is
   * what separates the two — a delete that partly succeeded must not also be
   * announced as one that failed outright.
   */
  it('absorbs the partial-failure report without reporting a delete failure too', async () => {
    const offloader = { deleteBatch: jest.fn().mockResolvedValue(['k1']) };
    const logger = throwingLogger();
    await expect(
      cleanUpS3Orphans(offloader as never, ['k1', 'k2'], 'put', logger, { rng: () => 0 }),
    ).resolves.toBeUndefined();
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Some orphaned'), {
      failedCount: 1,
    });
  });

  it('absorbs the throw from the final cleanup-failed report', async () => {
    const offloader = { deleteBatch: jest.fn().mockRejectedValue(accessDenied()) };
    const logger = throwingLogger();
    await expect(
      cleanUpS3Orphans(offloader as never, ['k1'], 'put', logger, { rng: () => 0 }),
    ).resolves.toBeUndefined();
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

/**
 * The same thing as a caller meets it. The refusal a payload of zero bytes
 * raises is a convenient trigger: the first write uploads, the second is
 * refused, and the builder releases what it had already uploaded — a release
 * that runs while the caller's `VALIDATION` is in flight.
 */
describe('DynamoDBSaver.putWrites with a logger that throws', () => {
  it('reports the refusal, not the logger, when the release cannot finish', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(QueryCommand).resolves({ Items: [] });
    mock.on(PutCommand).resolves({});
    mock.on(TransactWriteCommand).resolves({});
    s3Mock.on(PutObjectCommand).resolves({});
    s3Mock.on(DeleteObjectsCommand).rejects(accessDenied());
    const saver = new DynamoDBSaver({
      tableName: 'ckpt',
      client,
      logger: throwingLogger(),
      s3: {
        bucketName: 'b',
        thresholdBytes: 1,
        createS3Client: () => new S3Client({ region: 'us-east-1' }),
      },
    });
    const error = await saver
      .putWrites(
        { configurable: { thread_id: 't', checkpoint_ns: '', checkpoint_id: 'c1' } },
        [
          ['stored', 'a value large enough to offload'],
          ['refused', () => 1],
        ],
        'task',
      )
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    expect(error).toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'value' } });
    expect((error as Error).message).toContain('zero bytes');
    /** Unchanged means unchanged: the refusal's own stack, not a rethrow's. */
    const [header] = ((error as Error).stack ?? '').split('\n');
    expect(header).toBe(`DynamoDBLangGraphError: ${(error as Error).message}`);
    /**
     * Asserted, not assumed: the refusal reaches the caller just as well when
     * no release was attempted, so without this the test could not fail for
     * the reason it exists.
     */
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(1);
    expect(mock.commandCalls(PutCommand)).toHaveLength(0);
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});
