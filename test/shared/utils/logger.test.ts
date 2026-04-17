import { type Logger, redactLogger, redactSecrets } from '../../../src/shared';

describe('redactSecrets', () => {
  it('should redact values at secret-looking keys', () => {
    const input = {
      AccessKeyId: 'AKIA123',
      SecretAccessKey: 'abc/def',
      harmless: 'keep',
    };

    const out = redactSecrets(input) as Record<string, unknown>;

    expect(out.AccessKeyId).toBe('[REDACTED]');
    expect(out.SecretAccessKey).toBe('[REDACTED]');
    expect(out.harmless).toBe('keep');
  });

  it('should redact nested objects', () => {
    const input = {
      request: {
        headers: {
          Authorization: 'Bearer abc',
          'X-Amz-Security-Token': 'token-xyz',
          'X-Other': 'fine',
        },
      },
    };

    const out = redactSecrets(input) as any;

    expect(out.request.headers.Authorization).toBe('[REDACTED]');
    expect(out.request.headers['X-Amz-Security-Token']).toBe('[REDACTED]');
    expect(out.request.headers['X-Other']).toBe('fine');
  });

  it('should handle arrays without unwrapping objects inside', () => {
    const input = [
      { accessKey: 'x', username: 'u1' },
      { accessKey: 'y', username: 'u2' },
    ];

    const out = redactSecrets(input) as any[];

    expect(out[0].accessKey).toBe('[REDACTED]');
    expect(out[0].username).toBe('u1');
    expect(out[1].accessKey).toBe('[REDACTED]');
  });

  it('should not mutate the input', () => {
    const input = { password: 'hunter2', other: 'x' };
    redactSecrets(input);
    expect(input.password).toBe('hunter2');
  });

  it('should break cycles', () => {
    const input: any = { password: 'p' };
    input.self = input;

    const out = redactSecrets(input) as any;
    expect(out.password).toBe('[REDACTED]');
    expect(out.self).toBe('[Circular]');
  });

  it('should passthrough primitives', () => {
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets('hello')).toBe('hello');
    expect(redactSecrets(null)).toBe(null);
    expect(redactSecrets(undefined)).toBe(undefined);
  });

  it('should preserve Error instances intact', () => {
    const err = new Error('boom');
    const out = redactSecrets(err);
    expect(out).toBe(err);
  });
});

describe('redactLogger', () => {
  it('should redact secret-bearing args before handing them to the inner logger', () => {
    const calls: Array<{ level: string; msg: string; args: unknown[] }> = [];
    const inner: Logger = {
      info: (msg, ...args) => calls.push({ level: 'info', msg, args }),
      warn: (msg, ...args) => calls.push({ level: 'warn', msg, args }),
      error: (msg, ...args) => calls.push({ level: 'error', msg, args }),
      debug: (msg, ...args) => calls.push({ level: 'debug', msg, args }),
    };

    const wrapped = redactLogger(inner);
    wrapped.warn('request failed', { accessKey: 'x', attempt: 3 });

    expect(calls).toHaveLength(1);
    const arg0 = calls[0].args[0] as Record<string, unknown>;
    expect(arg0.accessKey).toBe('[REDACTED]');
    expect(arg0.attempt).toBe(3);
  });

  it('should leave the message string unchanged', () => {
    const inner: Logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    const wrapped = redactLogger(inner);
    wrapped.info('hello world', {});

    expect(inner.info).toHaveBeenCalledWith('hello world', {});
  });

  it('should honor extraKeys option', () => {
    const inner: Logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    const wrapped = redactLogger(inner, { extraKeys: ['ssn'] });
    wrapped.info('log', { ssn: '123-45-6789', name: 'alice' });

    const args = (inner.info as jest.Mock).mock.calls[0];
    expect(args[1].ssn).toBe('[REDACTED]');
    expect(args[1].name).toBe('alice');
  });
});
