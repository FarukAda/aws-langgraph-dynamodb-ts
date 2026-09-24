import { ensureLifecycleFor } from '../../../src/shared/adapter';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

describe('ensureLifecycleFor', () => {
  const offloader = () => ({ ensureLifecycleRule: jest.fn().mockResolvedValue(undefined) });

  it('installs a rule whose expiry matches the configured ttl, rounded up', async () => {
    const s3 = offloader();
    await ensureLifecycleFor({ logger, offloader: s3 as never, ttl: { days: 30 } });
    expect(s3.ensureLifecycleRule).toHaveBeenCalledWith(32, logger);
  });

  /**
   * S3 expresses expiry in whole days only, so a sub-day ttl rounds up — plus
   * the sweep margin, which is what keeps the object alive past the row.
   */
  it('rounds a sub-day ttl up to a whole day and adds the sweep margin', async () => {
    const s3 = offloader();
    await ensureLifecycleFor({ logger, offloader: s3 as never, ttl: { seconds: 3600 } });
    expect(s3.ensureLifecycleRule).toHaveBeenCalledWith(3, logger);
  });

  /** Without a bucket there is nothing to rule over. */
  it('does nothing without an offloader', async () => {
    await expect(ensureLifecycleFor({ logger, ttl: { days: 30 } })).resolves.toBeUndefined();
  });

  /** Without a ttl nothing expires, so any rule would delete a payload a live row needs. */
  it('does nothing without a ttl', async () => {
    const s3 = offloader();
    await ensureLifecycleFor({ logger, offloader: s3 as never });
    expect(s3.ensureLifecycleRule).not.toHaveBeenCalled();
  });

  it('propagates a failure to install the rule', async () => {
    const s3 = { ensureLifecycleRule: jest.fn().mockRejectedValue(new Error('denied')) };
    await expect(
      ensureLifecycleFor({ logger, offloader: s3 as never, ttl: { days: 1 } }),
    ).rejects.toThrow(/denied/);
  });
});
