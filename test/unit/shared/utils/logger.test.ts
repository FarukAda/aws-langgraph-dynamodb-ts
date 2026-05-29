/**
 * Unit tests for src/shared/utils/logger.ts.
 *
 * Pinned against real source:
 *  - public surface: setGlobalLogger, getLogger, resetLogger, redactLogger,
 *    redactSecrets, type Logger.
 *  - Logger methods are variadic: (message: string, ...args: unknown[]) => void.
 *  - redactSecrets replaces secret-keyed values with the exact token '[REDACTED]'.
 *  - secret keys are matched by CASE-INSENSITIVE SUBSTRING against the
 *    DEFAULT_SECRET_KEY_PATTERNS set: accesskey, secretkey, secret, sessiontoken,
 *    securitytoken, authorization, password, credential, apikey, bearer, token,
 *    privatekey.
 *  - Error instances are returned as-is (stack preserved), arrays walked,
 *    cycles broken with '[Circular]'.
 *  - redactLogger passes the message through unchanged and redacts only the
 *    variadic args; extraKeys extends the pattern set.
 */
import {
  getLogger,
  redactLogger,
  redactSecrets,
  resetLogger,
  setGlobalLogger,
  type Logger,
} from '../../../../src/index';

/** Exact redaction token emitted by source. */
const REDACTED = '[REDACTED]';

/** Recording logger capturing the full variadic arg list per call. */
function recordingLogger(): {
  logger: Logger;
  calls: Array<{ level: string; message: string; args: unknown[] }>;
} {
  const calls: Array<{ level: string; message: string; args: unknown[] }> = [];
  const rec =
    (level: string) =>
    (message: string, ...args: unknown[]): void => {
      calls.push({ level, message, args });
    };
  return {
    logger: { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') },
    calls,
  };
}

describe('logger: global logger seam', () => {
  afterEach(() => {
    resetLogger();
  });

  it('getLogger returns the exact logger installed via setGlobalLogger and forwards all variadic args', () => {
    const { logger, calls } = recordingLogger();

    setGlobalLogger(logger);
    const got = getLogger();
    got.info('hello', { attempt: 1 }, 'extra');

    expect(got).toBe(logger);
    expect(calls).toEqual([{ level: 'info', message: 'hello', args: [{ attempt: 1 }, 'extra'] }]);
  }); // AC-7

  it('resetLogger restores the default logger so a previously installed custom logger no longer receives entries', () => {
    const { logger, calls } = recordingLogger();

    setGlobalLogger(logger);
    resetLogger();
    getLogger().info('after-reset');

    expect(getLogger()).not.toBe(logger);
    expect(calls).toEqual([]);
  }); // AC-7
});

describe('logger: default console logger', () => {
  afterEach(() => {
    resetLogger();
    jest.restoreAllMocks();
  });

  it('routes each level to the matching console method with the [langgraph-dynamodb] prefix and forwards args', () => {
    // resetLogger guarantees we exercise the built-in default logger (not a custom
    // one left installed by another test), covering its warn/error/debug bodies.
    resetLogger();
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => undefined);

    const log = getLogger();
    log.info('i-msg', 1);
    log.warn('w-msg', 2);
    log.error('e-msg', 3);
    log.debug('d-msg', 4);

    expect(infoSpy).toHaveBeenCalledWith('[langgraph-dynamodb] i-msg', 1);
    expect(warnSpy).toHaveBeenCalledWith('[langgraph-dynamodb] w-msg', 2);
    expect(errorSpy).toHaveBeenCalledWith('[langgraph-dynamodb] e-msg', 3);
    expect(debugSpy).toHaveBeenCalledWith('[langgraph-dynamodb] d-msg', 4);
  }); // AC-7
});

describe('logger: redactSecrets', () => {
  it('preserves non-secret structured retry-log fields verbatim', () => {
    const input = {
      error: { name: 'ThrottlingException', message: 'Rate exceeded' },
      attempt: 2,
      tableName: 'test-table',
    };

    const redacted = redactSecrets(input) as typeof input;

    expect(redacted).toEqual({
      error: { name: 'ThrottlingException', message: 'Rate exceeded' },
      attempt: 2,
      tableName: 'test-table',
    });
  }); // AC-19

  it('replaces values at substring-matched secret keys with the exact [REDACTED] token and leaves others intact', () => {
    const input = {
      tableName: 't',
      awsSecretAccessKey: 'AKIAIOSFODNN7EXAMPLE',
      Authorization: 'Bearer abc',
      session_token: 'sess-123',
      password: 'hunter2',
      apiKey: 'k-9',
      privateKey: 'pk',
      attempt: 3,
    };

    const redacted = redactSecrets(input) as Record<string, unknown>;

    expect(redacted).toEqual({
      tableName: 't',
      awsSecretAccessKey: REDACTED,
      Authorization: REDACTED,
      session_token: REDACTED,
      password: REDACTED,
      apiKey: REDACTED,
      privateKey: REDACTED,
      attempt: 3,
    });
  }); // AC-19

  it('does not redact non-matching keys (negative case)', () => {
    const input = { tableName: 't', userId: 'u-1', count: 5 };

    const redacted = redactSecrets(input);

    expect(redacted).toEqual({ tableName: 't', userId: 'u-1', count: 5 });
  }); // AC-19

  it('returns Error instances unchanged so the stack survives redaction', () => {
    const err = new Error('boom');
    const input = { error: err, password: 'secret' };

    const redacted = redactSecrets(input) as { error: Error; password: string };

    expect(redacted.error).toBe(err);
    expect(redacted.password).toBe(REDACTED);
  }); // AC-19

  it('walks array elements, redacting secret-keyed values inside nested objects', () => {
    const input = [{ tableName: 't', password: 'hunter2' }, { count: 1 }, 'plain-string'];

    const redacted = redactSecrets(input) as unknown[];

    expect(redacted).toEqual([
      { tableName: 't', password: REDACTED },
      { count: 1 },
      'plain-string',
    ]);
  }); // AC-19

  it('breaks reference cycles with [Circular] instead of recursing infinitely', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;

    const redacted = redactSecrets(node) as Record<string, unknown>;

    expect(redacted.name).toBe('root');
    expect(redacted.self).toBe('[Circular]');
  }); // AC-19

  it('does not mutate the input object', () => {
    const input = { password: 'secret', keep: 1 };

    redactSecrets(input);

    expect(input).toEqual({ password: 'secret', keep: 1 });
  }); // AC-19
});

describe('logger: redactLogger', () => {
  it('passes the message through unchanged and redacts secret keys inside the variadic args', () => {
    const { logger: base, calls } = recordingLogger();

    const wrapped = redactLogger(base);
    wrapped.info('retry', { tableName: 't', attempt: 1, password: 'super-secret-token' });

    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe('info');
    expect(calls[0].message).toBe('retry');
    expect(calls[0].args).toEqual([{ tableName: 't', attempt: 1, password: REDACTED }]);
  }); // AC-19

  it('redacts keys named via extraKeys in addition to the defaults', () => {
    const { logger: base, calls } = recordingLogger();

    const wrapped = redactLogger(base, { extraKeys: ['ssn'] });
    wrapped.warn('m', { ssn: '123-45-6789', keep: 'ok' });

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([{ ssn: REDACTED, keep: 'ok' }]);
  }); // AC-19

  it('leaves a logger with no secret-bearing args untouched (negative case)', () => {
    const { logger: base, calls } = recordingLogger();

    const wrapped = redactLogger(base);
    wrapped.error('m', { tableName: 't', attempt: 4 });

    expect(calls[0].args).toEqual([{ tableName: 't', attempt: 4 }]);
  }); // AC-19

  it('redacts secret args on the debug level too (covers the wrapped debug method)', () => {
    const { logger: base, calls } = recordingLogger();

    const wrapped = redactLogger(base);
    wrapped.debug('trace', { token: 'abc', keep: 'ok' });

    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe('debug');
    expect(calls[0].message).toBe('trace');
    expect(calls[0].args).toEqual([{ token: REDACTED, keep: 'ok' }]);
  }); // AC-19
});
