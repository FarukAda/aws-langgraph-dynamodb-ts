import { MAX_LOGGED_VALUE_CHARS } from '../../../../src/shared/constants';
import { truncateForLog } from '../../../../src/shared/logging/truncate';
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
      /**
       * The error's name, never its text: the package promises its logs carry
       * identifiers and counts only, and a backend's message is neither.
       */
      expect.objectContaining({ key: 'k', reason: 'Error' }),
    );
  });

  /**
   * The name is the backend's own and nothing this package ran checked its
   * length. `message` is bounded where `redactedMessage` relays it, so
   * relaying the name whole would split what is one value — and this line
   * fires once per failed item.
   */
  it('cuts a backend error name past the log cap', async () => {
    const reason = 'B'.repeat(MAX_LOGGED_VALUE_CHARS * 4);
    const backend = {
      upsert: jest.fn().mockRejectedValue(Object.assign(new Error('down'), { name: reason })),
      delete: jest.fn(),
      query: jest.fn(),
    };
    const logger = fakeLogger();
    await syncVectorIndex(backend, ['n'], 'k', [1], logger);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: truncateForLog(reason) }),
    );
  });
});
