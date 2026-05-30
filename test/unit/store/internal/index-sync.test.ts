import { syncVectorIndex } from '../../../../src/store/internal/index-sync';

function fakeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

describe('syncVectorIndex', () => {
  it('upserts when an embedding is present', async () => {
    const backend = {
      upsert: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn(),
      query: jest.fn(),
    };
    await syncVectorIndex(backend, ['users', 'u1'], 'k', [0.1, 0.2], fakeLogger());
    expect(backend.upsert).toHaveBeenCalledWith(['users', 'u1'], 'k', [0.1, 0.2]);
    expect(backend.delete).not.toHaveBeenCalled();
  });

  it('deletes when no embedding is present', async () => {
    const backend = {
      upsert: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(),
    };
    await syncVectorIndex(backend, ['users'], 'k', undefined, fakeLogger());
    expect(backend.delete).toHaveBeenCalledWith(['users'], 'k');
    expect(backend.upsert).not.toHaveBeenCalled();
  });

  it('swallows and logs a backend failure (never throws)', async () => {
    const backend = {
      upsert: jest.fn().mockRejectedValue(new Error('backend down')),
      delete: jest.fn(),
      query: jest.fn(),
    };
    const logger = fakeLogger();
    await expect(syncVectorIndex(backend, ['n'], 'k', [1], logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('vector-index sync failed'),
      expect.objectContaining({ key: 'k', message: 'backend down' }),
    );
  });
});
