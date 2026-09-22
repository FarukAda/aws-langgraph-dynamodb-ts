import {
  absorbLoggerFailure,
  resolveLogger,
  SILENT_LOGGER,
} from '../../../../src/shared/logging/logger';

const LEVELS = ['info', 'warn', 'error', 'debug'] as const;

describe('logger', () => {
  it('SILENT_LOGGER swallows every level without throwing', () => {
    expect(() => {
      SILENT_LOGGER.info('a');
      SILENT_LOGGER.warn('b', { k: 1 });
      SILENT_LOGGER.error('c');
      SILENT_LOGGER.debug('d');
    }).not.toThrow();
  });

  it('resolveLogger falls back to SILENT_LOGGER when nothing is provided', () => {
    expect(resolveLogger()).toBe(SILENT_LOGGER);
  });

  it('resolveLogger delegates every level to the injected logger, arguments unchanged', () => {
    const custom = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const resolved = resolveLogger(custom);
    for (const level of LEVELS) resolved[level]('m', { k: 1 }, 'extra');
    for (const level of LEVELS) {
      expect(custom[level]).toHaveBeenCalledWith('m', { k: 1 }, 'extra');
    }
  });

  /**
   * The contract this changed. `resolveLogger` is the single funnel every
   * adapter's logger comes through, and what it hands the internals is a
   * wrapper rather than the object it was given — which is the whole point:
   * the wrapper is what a `catch` block, and the retry hook, can call without
   * treating the log line as a failure path of its own.
   */
  it('resolveLogger returns a wrapper, not the object it was handed', () => {
    const custom = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    expect(resolveLogger(custom)).not.toBe(custom);
  });

  it.each(LEVELS)('resolveLogger absorbs a throw out of an injected %s', (level) => {
    const boom = jest.fn((): never => {
      throw new TypeError('logger transport closed');
    });
    const resolved = resolveLogger({ info: boom, warn: boom, error: boom, debug: boom });
    expect(() => resolved[level]('m', { k: 1 })).not.toThrow();
    expect(boom).toHaveBeenCalledTimes(1);
  });
});

/**
 * The guard the funnel is built on. It is shared rather than private to any
 * one caller because a `Logger` is consumer code wherever it is called, and a
 * guard each site has to remember is a guard most sites will not have.
 */
describe('absorbLoggerFailure', () => {
  it('runs the call and reports nothing back', () => {
    const emit = jest.fn();
    expect(absorbLoggerFailure(emit)).toBeUndefined();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('swallows whatever the call throws', () => {
    expect(() =>
      absorbLoggerFailure(() => {
        throw new TypeError('logger transport closed');
      }),
    ).not.toThrow();
  });
});
