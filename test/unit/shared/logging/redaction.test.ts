import { RetryExhaustedError } from '../../../../src/shared/errors/errors';
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

  it("redacts a custom Error subclass's own secret-looking properties, preserving name/message/stack", () => {
    class BatchFailure extends Error {
      readonly unprocessed: { token: string; itemCount: number };
      constructor(message: string, unprocessed: { token: string; itemCount: number }) {
        super(message);
        this.name = 'BatchFailure';
        this.unprocessed = unprocessed;
      }
    }
    const error = new BatchFailure('write failed', { token: 'SENSITIVE', itemCount: 5 });
    const out = redactSecrets({ err: error } as never) as unknown as {
      err: { name: string; message: string; stack: unknown; unprocessed: unknown };
    };
    expect(out.err.name).toBe('BatchFailure');
    expect(out.err.message).toBe('write failed');
    expect(out.err.stack).toBe(error.stack);
    expect(out.err.unprocessed).toEqual({ token: '[REDACTED]', itemCount: 5 });
  });

  it('preserves the cause chain when rebuilding an error', () => {
    // `super(message, { cause })` makes `cause` non-enumerable per spec, so
    // Object.entries skips it. Every library error attaches its own
    // enumerable code/context, so the rebuild path always fires for them —
    // dropping the underlying AWS failure that a redacted RetryExhaustedError
    // exists to report.
    const root = Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
    const wrapper = new RetryExhaustedError('Operation failed after 5 attempts', 5, root);
    const out = redactSecrets({ err: wrapper } as never) as unknown as {
      err: { cause?: { name: string; message: string } };
    };
    expect(out.err.cause).toBeDefined();
    expect(out.err.cause?.name).toBe('ThrottlingException');
    expect(out.err.cause?.message).toBe('throttled');
  });

  it('redacts secrets inside a preserved cause chain', () => {
    const root = Object.assign(new Error('rejected AKIAIOSFODNN7EXAMPLE'), { token: 'sk-live-1' });
    const wrapper = new RetryExhaustedError('wrapped', 2, root);
    const out = redactSecrets({ err: wrapper } as never) as unknown as {
      err: { cause?: { message: string; token: string } };
    };
    expect(out.err.cause?.message).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out.err.cause?.token).toBe('[REDACTED]');
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

describe('redactSecrets value patterns (I1)', () => {
  it('redacts a secret embedded in an error message, not just in a structured field', () => {
    const wrapped = new Error('creds AKIAIOSFODNN7EXAMPLE rejected');
    const error = Object.assign(new Error(`Operation failed: ${wrapped.message}`), {
      code: 'RETRY_EXHAUSTED',
    });
    const out = redactSecrets({ err: error } as never) as unknown as {
      err: { message: string };
    };
    expect(out.err.message).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out.err.message).toContain('[REDACTED]');
    expect(out.err.message).toContain('Operation failed:');
  });

  it('rebuilds a bare Error whose message carries a secret rather than passing it through', () => {
    const error = new Error('token=abcdef123456 expired');
    const out = redactSecrets({ err: error } as never) as unknown as { err: { message: string } };
    expect(out.err).not.toBe(error);
    expect(out.err.message).not.toContain('abcdef123456');
  });

  it('handles an error carrying no stack at all', () => {
    const error = Object.assign(new Error('boom'), { stack: undefined, code: 'X' });
    const out = redactSecrets({ err: error } as never) as unknown as {
      err: { message: string; stack: unknown };
    };
    expect(out.err.message).toBe('boom');
    expect(out.err.stack).toBeUndefined();
  });

  it('redacts bearer tokens and password assignments inside plain strings', () => {
    const out = redactSecrets({
      note: 'Bearer abc.def.ghi sent; password=hunter2',
    }) as unknown as { note: string };
    expect(out.note).not.toContain('hunter2');
    expect(out.note).not.toContain('abc.def.ghi');
  });

  it('leaves ordinary operational text untouched', () => {
    expect(redactSecrets({ note: 'thread-1 deleted 25 rows' })).toEqual({
      note: 'thread-1 deleted 25 rows',
    });
  });
});

describe('redactSecrets non-plain values (M1)', () => {
  it('preserves Date and RegExp instead of collapsing them to an empty object', () => {
    const date = new Date('2026-08-29T00:00:00.000Z');
    const out = redactSecrets({ date, re: /ab+c/gi } as never) as unknown as {
      date: Date;
      re: RegExp;
    };
    expect(out.date).toBe(date);
    expect(String(out.re)).toBe('/ab+c/gi');
  });

  it('summarises typed arrays instead of exploding them into numeric keys', () => {
    const out = redactSecrets({ buf: new Uint8Array([1, 2, 3]) } as never) as unknown as {
      buf: string;
    };
    expect(out.buf).toBe('[Uint8Array(3)]');
  });

  it('recurses a Set into an array of its members', () => {
    const out = redactSecrets({ set: new Set([1, 2]) } as never) as unknown as { set: number[] };
    expect(out.set).toEqual([1, 2]);
  });

  it('recurses a Map while still redacting secret-looking entry keys', () => {
    const map = new Map<string, unknown>([
      ['password', 'hunter2'],
      ['id', 'thread-1'],
    ]);
    const out = redactSecrets({ map } as never) as unknown as {
      map: Record<string, unknown>;
    };
    expect(out.map).toEqual({ password: '[REDACTED]', id: 'thread-1' });
  });

  it('stringifies a non-string Map key so the entry is still reported', () => {
    const map = new Map<number, string>([[7, 'seven']]);
    const out = redactSecrets({ map } as never) as unknown as { map: Record<string, unknown> };
    expect(out.map).toEqual({ '7': 'seven' });
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

  it('honors extra value patterns supplied via options (I1)', () => {
    const inner = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    redactLogger(inner, { extraValuePatterns: [/CORP-\d{4}/g] }).info('x', {
      note: 'ticket CORP-1234',
    });
    expect(inner.info).toHaveBeenCalledWith('x', { note: 'ticket [REDACTED]' });
  });
});

describe('credential-value redaction (F2)', () => {
  it('redacts a JSON-quoted pair, which the bare-keyword pattern missed entirely', () => {
    expect(redactSecrets('{"password":"hunter2"}')).toBe('{"password":[REDACTED]}');
  });

  it('redacts only the value, leaving sibling JSON fields intact', () => {
    expect(redactSecrets('{"password":"hunter2","user":"bob"}')).toBe(
      '{"password":[REDACTED],"user":"bob"}',
    );
  });

  it('redacts a JSON body embedded in free error text', () => {
    expect(redactSecrets('Request failed: {"apiKey":"sk-live-abc"} (status 401)')).toBe(
      'Request failed: {"apiKey":[REDACTED]} (status 401)',
    );
  });

  it('redacts a single-quoted value', () => {
    expect(redactSecrets("{'password': 'hunter2', 'keep': 1}")).toBe(
      "{'password': [REDACTED], 'keep': 1}",
    );
  });

  it('redacts a multi-word unquoted value whole, not up to its first space', () => {
    expect(redactSecrets('password: correct horse battery staple')).toBe('password: [REDACTED]');
  });

  it('stops an unquoted value at end of line so it cannot swallow a stack frame', () => {
    expect(redactSecrets('at foo\npassword: s3cret\n    at bar')).toBe(
      'at foo\npassword: [REDACTED]\n    at bar',
    );
  });

  it('keeps the field name visible so a log still says what was redacted', () => {
    expect(redactSecrets('apiKey=sk-live-abc')).toBe('apiKey=[REDACTED]');
  });

  it('still replaces an ungrouped pattern whole', () => {
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE')).toBe('[REDACTED]');
    expect(redactSecrets('Authorization: Bearer abc.def')).toBe('Authorization: [REDACTED]');
  });

  it('does not over-redact ordinary operational text', () => {
    expect(redactSecrets('retry 3 of 5 after ThrottlingException')).toBe(
      'retry 3 of 5 after ThrottlingException',
    );
    expect(redactSecrets('tokenizer: fast')).toBe('tokenizer: fast');
  });

  it('redacts an unquoted JSON scalar without swallowing its siblings', () => {
    // The value side had no scalar alternative, so a number fell through to
    // the end-of-line fallback and destroyed every field after it:
    // {"apiKey":123,"region":"us-east-1"} collapsed to {"apiKey":[REDACTED].
    expect(redactSecrets('{"apiKey":123,"region":"us-east-1"}')).toBe(
      '{"apiKey":[REDACTED],"region":"us-east-1"}',
    );
    expect(redactSecrets('{"password":true,"user":"bob"}')).toBe(
      '{"password":[REDACTED],"user":"bob"}',
    );
    expect(redactSecrets('{"token":null,"retries":3}')).toBe('{"token":[REDACTED],"retries":3}');
    expect(redactSecrets('{"apiKey":-1.5e3,"user":"bob"}')).toBe(
      '{"apiKey":[REDACTED],"user":"bob"}',
    );
  });

  it('still redacts an unquoted value whole when it merely starts with digits', () => {
    // The scalar alternative must not truncate a value it does not fully
    // describe, or it would leak the tail it left behind.
    expect(redactSecrets('token=123abc')).toBe('token=[REDACTED]');
  });

  it('consumes a quoted value containing an escaped quote, instead of leaking its tail', () => {
    // "a\"b" ended the quoted span at the escaped quote, so the redaction
    // stopped short and printed the rest of the secret verbatim.
    expect(redactSecrets(JSON.stringify({ password: 'a"b', user: 'bob' }))).toBe(
      '{"password":[REDACTED],"user":"bob"}',
    );
    expect(redactSecrets(String.raw`{'password': 'a\'b', 'keep': 1}`)).toBe(
      "{'password': [REDACTED], 'keep': 1}",
    );
  });

  it('reaches a secret inside an Error message via the rebuild path', () => {
    const error = Object.assign(new Error('failed {"password":"hunter2"}'), { code: 'X' });
    const redacted = redactSecrets(error as never) as { message: string };
    expect(redacted.message).toBe('failed {"password":[REDACTED]}');
  });
});
