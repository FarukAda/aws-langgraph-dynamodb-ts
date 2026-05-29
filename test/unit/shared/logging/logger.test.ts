import { resolveLogger, SILENT_LOGGER } from '../../../../src/shared/logging/logger';

describe('logger', () => {
  it('SILENT_LOGGER swallows every level without throwing', () => {
    expect(() => {
      SILENT_LOGGER.info('a');
      SILENT_LOGGER.warn('b', { k: 1 });
      SILENT_LOGGER.error('c');
      SILENT_LOGGER.debug('d');
    }).not.toThrow();
  });

  it('resolveLogger returns the injected logger when provided', () => {
    const custom = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    expect(resolveLogger(custom)).toBe(custom);
  });

  it('resolveLogger falls back to SILENT_LOGGER when nothing is provided', () => {
    expect(resolveLogger()).toBe(SILENT_LOGGER);
  });
});
