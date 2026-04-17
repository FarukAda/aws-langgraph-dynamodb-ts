import { cleanUpS3Orphans, type Logger, setGlobalLogger, resetLogger } from '../../../src/shared';

type DeleteBatchMock = jest.Mock<Promise<void>, [string[]]>;

function makeOffloader(deleteBatch: DeleteBatchMock) {
  return { deleteBatch } as unknown as import('../../../src/shared').S3Offloader;
}

describe('cleanUpS3Orphans', () => {
  let warnCalls: string[];

  beforeEach(() => {
    warnCalls = [];
    const logger: Logger = {
      info: () => {},
      warn: (msg: string) => warnCalls.push(msg),
      error: () => {},
      debug: () => {},
    };
    setGlobalLogger(logger);
  });

  afterEach(() => {
    resetLogger();
  });

  it('is a no-op when no keys are given', async () => {
    const deleteBatch: DeleteBatchMock = jest.fn();
    await cleanUpS3Orphans(makeOffloader(deleteBatch), [], 'test');
    expect(deleteBatch).not.toHaveBeenCalled();
  });

  it('filters out undefined and empty keys', async () => {
    const deleteBatch: DeleteBatchMock = jest.fn().mockResolvedValue(undefined);
    await cleanUpS3Orphans(
      makeOffloader(deleteBatch),
      [undefined, '', 'a', undefined, 'b'],
      'test',
    );
    expect(deleteBatch).toHaveBeenCalledWith(['a', 'b']);
  });

  it('retries transient S3 errors and eventually succeeds', async () => {
    const slowDown = Object.assign(new Error('slow down'), { name: 'SlowDown' });
    const deleteBatch: DeleteBatchMock = jest
      .fn()
      .mockRejectedValueOnce(slowDown)
      .mockRejectedValueOnce(slowDown)
      .mockResolvedValueOnce(undefined);

    await cleanUpS3Orphans(makeOffloader(deleteBatch), ['k'], 'put failure');

    expect(deleteBatch).toHaveBeenCalledTimes(3);
    expect(warnCalls).toHaveLength(0);
  });

  it('gives up after max attempts on persistent transient errors and logs once', async () => {
    const slowDown = Object.assign(new Error('slow down'), { name: 'SlowDown' });
    const deleteBatch: DeleteBatchMock = jest.fn().mockRejectedValue(slowDown);

    await cleanUpS3Orphans(makeOffloader(deleteBatch), ['k'], 'put failure');

    expect(deleteBatch).toHaveBeenCalledTimes(3);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toContain('put failure');
    expect(warnCalls[0]).toContain('3 attempts');
  });

  it('does not retry non-transient errors', async () => {
    const accessDenied = Object.assign(new Error('nope'), { name: 'AccessDenied' });
    const deleteBatch: DeleteBatchMock = jest.fn().mockRejectedValue(accessDenied);

    await cleanUpS3Orphans(makeOffloader(deleteBatch), ['k'], 'put failure');

    // Non-transient → bail on first failure, log once.
    expect(deleteBatch).toHaveBeenCalledTimes(1);
    expect(warnCalls).toHaveLength(1);
  });

  it('retries on 5xx $metadata status codes', async () => {
    const serverError = Object.assign(new Error('server'), {
      name: 'SomeOddName',
      $metadata: { httpStatusCode: 503 },
    });
    const deleteBatch: DeleteBatchMock = jest
      .fn()
      .mockRejectedValueOnce(serverError)
      .mockResolvedValueOnce(undefined);

    await cleanUpS3Orphans(makeOffloader(deleteBatch), ['k'], 'put failure');

    expect(deleteBatch).toHaveBeenCalledTimes(2);
  });
});
