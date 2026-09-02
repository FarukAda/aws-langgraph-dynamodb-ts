import { withRetry } from '../../../../src/shared/dynamodb/retry';
import { CompensationFailedError } from '../../../../src/shared/errors/errors';
import { redactLogger, redactSecrets } from '../../../../src/shared/logging/redaction';

type Redacted = Record<string, unknown>;

describe('redactSecrets key matching (CORE-03, CORE-13)', () => {
  it('redacts snake_case, kebab-case and upper-case credential names', () => {
    const out = redactSecrets({
      api_key: 'plain-looking-value',
      'x-api-key': 'xk',
      private_key: 'pk',
      access_key: 'ak',
      client_secret: 'cs',
      AUTH_TOKEN: 'at',
      Authorization: 'Basic abc',
      passphrase: 'pp',
    } as never) as Redacted;
    expect(Object.values(out).every((value) => value === '[REDACTED]')).toBe(true);
  });

  it('leaves LLM telemetry and look-alike words untouched', () => {
    const input = {
      maxTokens: 10,
      total_tokens: 25,
      tokenUsage: { input: 1, output: 2 },
      tokenizer: 'cl100k_base',
      secretary: 'Ann',
      passwordless: true,
      region: 'eu-central-1',
    };
    expect(redactSecrets(input as never)).toEqual(input);
  });

  it('still redacts the names it always did', () => {
    const out = redactSecrets({
      accessKeyId: 'AKIA…',
      secretAccessKey: 's',
      sessionToken: 't',
      password: 'p',
      apiKey: 'k',
      token: 'tk',
    } as never) as Redacted;
    expect(Object.values(out).every((value) => value === '[REDACTED]')).toBe(true);
  });

  it('normalises extra keys the same way', () => {
    const inner = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    redactLogger(inner, { extraKeys: ['ssn'] }).info('x', { user_ssn: '123', SSN: '456', ok: 1 });
    expect(inner.info).toHaveBeenCalledWith('x', {
      user_ssn: '[REDACTED]',
      SSN: '[REDACTED]',
      ok: 1,
    });
  });
});

describe('redactSecrets error handling (CORE-02, CORE-20)', () => {
  it('rebuilds a bare Error whose cause carries a secret instead of passing it by reference', () => {
    const error = new Error('outer', { cause: { password: 'hunter2', region: 'eu' } });
    const out = redactSecrets({ err: error } as never) as unknown as {
      err: Error & { cause?: { password: string; region: string } };
    };
    expect(out.err).not.toBe(error);
    expect(out.err.message).toBe('outer');
    expect(out.err.cause).toEqual({ password: '[REDACTED]', region: 'eu' });
    expect(error.cause).toEqual({ password: 'hunter2', region: 'eu' });
  });

  it('still passes a bare Error without a cause through by reference', () => {
    const error = new Error('plain');
    expect((redactSecrets({ err: error } as never) as unknown as { err: Error }).err).toBe(error);
  });

  it('treats a __proto__ key as data, never as the prototype', () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"password":"p"}') as Redacted;
    const out = redactSecrets(input as never) as Redacted;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect((out as { polluted?: boolean }).polluted).toBeUndefined();
    expect(out.password).toBe('[REDACTED]');
  });

  it("keeps an AggregateError's errors, redacted", () => {
    const aggregate = new AggregateError(
      [Object.assign(new Error('one'), { token: 'secret-1' }), new Error('two')],
      'several failed',
    );
    const out = redactSecrets({ err: aggregate } as never) as unknown as {
      err: { message: string; errors: { message: string; token?: string }[] };
    };
    expect(out.err.message).toBe('several failed');
    expect(out.err.errors).toHaveLength(2);
    expect(out.err.errors[0].token).toBe('[REDACTED]');
    expect(out.err.errors[1].message).toBe('two');
  });

  it('keeps a DOMException readable instead of collapsing it to an empty object', () => {
    const exception = new DOMException('The operation was aborted', 'AbortError');
    const out = redactSecrets({ err: exception } as never) as unknown as {
      err: { name: string; message: string };
    };
    expect(out.err.name).toBe('AbortError');
    expect(out.err.message).toBe('The operation was aborted');
  });
});

describe('redactLogger never throws into the caller (CORE-10)', () => {
  it('substitutes a marker for an argument whose redaction fails', () => {
    const inner = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const hostile = {
      get secret(): string {
        throw new Error('getter exploded');
      },
    };
    expect(() => redactLogger(inner).warn('careful', hostile, { ok: 1 })).not.toThrow();
    expect(inner.warn).toHaveBeenCalledWith('careful', '[UNREDACTABLE]', { ok: 1 });
  });
});

describe('error messages that embed an upstream message (CORE-23)', () => {
  it('redacts a credential inside the cause message of a RetryExhaustedError', async () => {
    const cause = Object.assign(new Error('connect failed: password=hunter2 host=db'), {
      name: 'ECONNRESET',
    });
    await expect(
      withRetry(
        async () => {
          throw cause;
        },
        { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      ),
    ).rejects.toMatchObject({
      name: 'RetryExhaustedError',
      message: expect.stringContaining('password=[REDACTED]'),
    });
  });

  it('redacts credentials inside both messages of a CompensationFailedError', () => {
    const error = new CompensationFailedError(
      new Error('trigger token=abc123'),
      new Error('rollback secret_access_key=xyz'),
    );
    expect(error.message).not.toContain('abc123');
    expect(error.message).not.toContain('xyz');
    expect(error.message).toContain('[REDACTED]');
  });
});
