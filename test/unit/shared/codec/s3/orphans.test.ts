import { cleanUpS3Orphans } from '../../../../../src/shared/codec/s3/orphans';

function fakeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

describe('cleanUpS3Orphans', () => {
  it('deletes the non-empty keys and does not warn on success', async () => {
    const offloader = { deleteBatch: jest.fn().mockResolvedValue([]) };
    const logger = fakeLogger();
    await cleanUpS3Orphans(offloader as never, ['k1', undefined, ''], 'put', logger);
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['k1']);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns when deleteBatch reports keys it could not delete', async () => {
    const offloader = { deleteBatch: jest.fn().mockResolvedValue(['k1']) };
    const logger = fakeLogger();
    await cleanUpS3Orphans(offloader as never, ['k1', 'k2'], 'put', logger);
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when there are no real keys', async () => {
    const offloader = { deleteBatch: jest.fn() };
    await cleanUpS3Orphans(offloader as never, [undefined, ''], 'put', fakeLogger());
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
  });

  it('retries a transient failure then succeeds without warning', async () => {
    const transient = Object.assign(new Error('slow'), { name: 'SlowDown' });
    const offloader = {
      deleteBatch: jest.fn().mockRejectedValueOnce(transient).mockResolvedValueOnce([]),
    };
    const logger = fakeLogger();
    await cleanUpS3Orphans(offloader as never, ['k1'], 'put', logger, { rng: () => 0 });
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('treats a 5xx httpStatusCode as transient and retries', async () => {
    const serverError = Object.assign(new Error('boom'), { $metadata: { httpStatusCode: 503 } });
    const offloader = {
      deleteBatch: jest.fn().mockRejectedValueOnce(serverError).mockResolvedValueOnce([]),
    };
    const logger = fakeLogger();
    await cleanUpS3Orphans(offloader as never, ['k1'], 'put', logger, { rng: () => 0 });
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('treats a 429 httpStatusCode as transient and retries', async () => {
    const throttle = Object.assign(new Error('slow'), { $metadata: { httpStatusCode: 429 } });
    const offloader = {
      deleteBatch: jest.fn().mockRejectedValueOnce(throttle).mockResolvedValueOnce([]),
    };
    await cleanUpS3Orphans(offloader as never, ['k1'], 'put', fakeLogger(), { rng: () => 0 });
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-transient failure and warns once', async () => {
    const offloader = { deleteBatch: jest.fn().mockRejectedValue(new Error('AccessDenied')) };
    const logger = fakeLogger();
    await cleanUpS3Orphans(offloader as never, ['k1'], 'put', logger, { rng: () => 0 });
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('stops retrying when the abort signal fires and still never throws', async () => {
    const transient = Object.assign(new Error('slow'), { name: 'SlowDown' });
    const offloader = { deleteBatch: jest.fn().mockRejectedValue(transient) };
    const logger = fakeLogger();
    const controller = new AbortController();
    controller.abort();
    await expect(
      cleanUpS3Orphans(offloader as never, ['k1'], 'put', logger, {
        rng: () => 0,
        signal: controller.signal,
      }),
    ).resolves.toBeUndefined();
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('warns and does not throw when transient deletion keeps failing', async () => {
    const transient = Object.assign(new Error('slow'), { name: 'SlowDown' });
    const offloader = { deleteBatch: jest.fn().mockRejectedValue(transient) };
    const logger = fakeLogger();
    await expect(
      cleanUpS3Orphans(offloader as never, ['k1'], 'put', logger, { rng: () => 0, maxAttempts: 2 }),
    ).resolves.toBeUndefined();
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
