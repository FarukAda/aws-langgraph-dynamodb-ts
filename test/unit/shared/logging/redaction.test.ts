import { redactLogger, redactSecrets } from '../../../../src/shared/logging/redaction';

describe('redactSecrets', () => {
  it('replaces secret-looking keys at any depth, leaving others intact', () => {
    const input = {
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIA', secretAccessKey: 's' },
    };
    expect(redactSecrets(input)).toEqual({
      region: 'us-east-1',
      credentials: { accessKeyId: '[REDACTED]', secretAccessKey: '[REDACTED]' },
    });
  });

  it('does not mutate the input and breaks cycles', () => {
    const input: Record<string, unknown> = { a: 1 };
    input.self = input;
    const out = redactSecrets(input as never) as Record<string, unknown>;
    expect(input.self).toBe(input);
    expect(out.self).toBe('[Circular]');
  });

  it('passes primitives through', () => {
    expect(redactSecrets('hello')).toBe('hello');
    expect(redactSecrets(42)).toBe(42);
  });

  it('recurses into arrays, redacting secret keys inside elements', () => {
    const input = { items: [{ password: 'p', name: 'n' }] };
    expect(redactSecrets(input)).toEqual({ items: [{ password: '[REDACTED]', name: 'n' }] });
  });

  it('passes Error objects through unchanged so stack traces survive', () => {
    const error = new Error('boom');
    const input = { failure: error } as never;
    const out = redactSecrets(input) as unknown as { failure: Error };
    expect(out.failure).toBe(error);
  });

  it('does not flag a DAG-shared (non-cyclic) object as circular', () => {
    const shared = { note: 'hello' };
    const result = redactSecrets({ a: shared, b: shared });
    expect(result).toEqual({ a: { note: 'hello' }, b: { note: 'hello' } });
  });

  it('passes through a repeated (non-cyclic) Error reference at both occurrences', () => {
    const err = new Error('boom');
    const result = redactSecrets({ a: err, b: err } as never) as { a: unknown; b: unknown };
    expect(result.a).toBe(err);
    expect(result.b).toBe(err);
  });
});

describe('redactLogger', () => {
  it('redacts object args before delegating, leaving the message untouched', () => {
    const inner = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    redactLogger(inner).warn('uploading', { token: 'abc', bucket: 'b' });
    expect(inner.warn).toHaveBeenCalledWith('uploading', { token: '[REDACTED]', bucket: 'b' });
  });

  it('redacts on every level method', () => {
    const inner = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const wrapped = redactLogger(inner);
    wrapped.info('a', { password: 'p' });
    wrapped.error('b', { password: 'p' });
    wrapped.debug('c', { password: 'p' });
    expect(inner.info).toHaveBeenCalledWith('a', { password: '[REDACTED]' });
    expect(inner.error).toHaveBeenCalledWith('b', { password: '[REDACTED]' });
    expect(inner.debug).toHaveBeenCalledWith('c', { password: '[REDACTED]' });
  });

  it('honors extra secret keys supplied via options', () => {
    const inner = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    redactLogger(inner, { extraKeys: ['pin'] }).info('x', { pin: '1234', label: 'ok' });
    expect(inner.info).toHaveBeenCalledWith('x', { pin: '[REDACTED]', label: 'ok' });
  });
});
