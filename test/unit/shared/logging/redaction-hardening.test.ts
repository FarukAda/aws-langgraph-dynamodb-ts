import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';

import { downloadObject, uploadObject } from '../../../../src/shared/codec/s3/offloader';
import { withRetry } from '../../../../src/shared/dynamodb/retry';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { compensationFailedError } from '../../../../src/shared/errors/errors';
import { redactLogger, redactSecrets } from '../../../../src/shared/logging/redaction';
import { redactText } from '../../../../src/shared/logging/secret-patterns';

type Redacted = Record<string, unknown>;

/**
 * Assert the refusal a caller can actually branch on: this package's own
 * `VALIDATION` error, naming the argument at fault — not merely "it did not
 * raise a `TypeError`".
 */
function expectRedactionRefusal(run: () => void, field: string): void {
  try {
    run();
    throw new Error(`expected a refusal naming ${field}`);
  } catch (error) {
    const refusal = error as { name?: string; code?: string; context?: { field?: string } };
    expect(refusal.name).toBe('DynamoDBLangGraphError');
    expect(refusal.code).toBe(ErrorCode.VALIDATION);
    expect(refusal.context?.field).toBe(field);
  }
}

describe('redactSecrets key matching', () => {
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
    }) as Redacted;
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
    }) as Redacted;
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

describe('redactSecrets error handling', () => {
  it('rebuilds a bare Error whose cause carries a secret instead of passing it by reference', () => {
    const error = new Error('outer', { cause: { password: 'hunter2', region: 'eu' } });
    const out = redactSecrets({ err: error }) as unknown as {
      err: Error & { cause?: { password: string; region: string } };
    };
    expect(out.err).not.toBe(error);
    expect(out.err.message).toBe('outer');
    expect(out.err.cause).toEqual({ password: '[REDACTED]', region: 'eu' });
    expect(error.cause).toEqual({ password: 'hunter2', region: 'eu' });
  });

  it('still passes a bare Error without a cause through by reference', () => {
    const error = new Error('plain');
    expect((redactSecrets({ err: error }) as unknown as { err: Error }).err).toBe(error);
  });

  it('treats a __proto__ key as data, never as the prototype', () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"password":"p"}') as Redacted;
    const out = redactSecrets(input) as Redacted;
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
    const out = redactSecrets({ err: aggregate }) as unknown as {
      err: { message: string; errors: { message: string; token?: string }[] };
    };
    expect(out.err.message).toBe('several failed');
    expect(out.err.errors).toHaveLength(2);
    expect(out.err.errors[0].token).toBe('[REDACTED]');
    expect(out.err.errors[1].message).toBe('two');
  });

  it('keeps a DOMException readable instead of collapsing it to an empty object', () => {
    const exception = new DOMException('The operation was aborted', 'AbortError');
    const out = redactSecrets({ err: exception }) as unknown as {
      err: { name: string; message: string };
    };
    expect(out.err.name).toBe('AbortError');
    expect(out.err.message).toBe('The operation was aborted');
  });
});

/**
 * The walk is recursive, so a structure deeper than the stack can hold raises
 * `RangeError` from inside it. A caller who asked for a redacted copy gets the
 * marker the wrapped logger would have substituted, not a thrown stack error.
 */
describe('redactSecrets on a structure deeper than the stack', () => {
  it('yields the marker instead of a RangeError', () => {
    const root: Record<string, unknown> = {};
    let tip = root;
    for (let depth = 0; depth < 200_000; depth += 1) {
      const next: Record<string, unknown> = {};
      tip.next = next;
      tip = next;
    }

    expect(redactSecrets(root)).toBe('[UNREDACTABLE]');
  });
});

/**
 * A failure of the data is answered with the same marker as a failure of the
 * walk. The caller asked for a value it could log, and it is about to log it
 * from a `catch`: a redactor that throws there replaces the failure being
 * reported with a `TypeError` about a getter.
 */
describe('redactSecrets on a value whose own accessors fail', () => {
  it.each([
    ['an Error', new TypeError('getter exploded')],
    ['a thrown non-object', null],
  ])('yields the marker for %s raised by a getter', (_name, thrown) => {
    const hostile = {
      get secret(): string {
        throw thrown;
      },
    };
    expect(redactSecrets(hostile)).toBe('[UNREDACTABLE]');
  });
});

/**
 * A redaction rule that quietly protects nothing is worse than none: the caller
 * believes the secret is hidden. Each of these failed silently.
 */
describe('redactLogger refuses options that would not redact', () => {
  const inner = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

  it('rejects a non-string extraKeys entry, instead of a TypeError at the first log', () => {
    expect(() => redactLogger(inner, { extraKeys: [42 as unknown as string] })).toThrow(
      /extraKeys/,
    );
  });

  it('rejects a non-RegExp extraValuePatterns entry', () => {
    expect(() =>
      redactLogger(inner, { extraValuePatterns: ['password' as unknown as RegExp] }),
    ).toThrow(/extraValuePatterns/);
  });

  it('accepts the shapes it documents', () => {
    expect(() =>
      redactLogger(inner, { extraKeys: ['ssn'], extraValuePatterns: [/x-\d+/g] }),
    ).not.toThrow();
  });

  /**
   * Each of these reached a string or array method and raised a bare
   * `TypeError` — or, for the two that are merely falsy, was read as "no
   * options given" and left the caller running unredacted on a default it
   * believed it had overridden.
   */
  it.each([null, 'x', 1])('names options for %p, which carries no rule at all', (options) => {
    expectRedactionRefusal(() => redactLogger(inner, options as never), 'options');
  });

  it.each([
    ['extraKeys', { extraKeys: 'ssn' }],
    ['extraKeys', { extraKeys: null }],
  ])('names %s for a list that is not an array of strings', (field, options) => {
    expectRedactionRefusal(() => redactLogger(inner, options as never), field);
  });

  it('names extraValuePatterns for a list that is not an array', () => {
    expectRedactionRefusal(
      () => redactLogger(inner, { extraValuePatterns: 'x' } as never),
      'extraValuePatterns',
    );
  });
});

/**
 * The wrapper delegates to a `Logger` a consumer implements. A missing method
 * is a wiring mistake, and finding it at the wrap call names it once, where it
 * was made, instead of raising `inner.info is not a function` at the first log
 * line — which is typically inside a `catch`, reporting something else.
 */
describe('redactLogger refuses a logger it cannot delegate to', () => {
  it.each([undefined, null, 'x', 1])('names logger for %p', (value) => {
    expectRedactionRefusal(() => redactLogger(value as never), 'logger');
  });

  it.each([
    [{}, 'logger.debug'],
    [{ info(): void {} }, 'logger.debug'],
    [{ debug(): void {}, info(): void {}, warn(): void {} }, 'logger.error'],
  ])('names the first missing method of %p', (value, field) => {
    expectRedactionRefusal(() => redactLogger(value as never), field);
  });
});

/**
 * Past the wrap call the wrapper promises to throw nothing, and the wrapped
 * logger is foreign code: one whose transport has closed, or that asserts on a
 * field it did not expect, threw straight through the wrapper and became the
 * error the caller saw instead of the one it was reporting.
 */
describe('redactLogger absorbs a failure of the logger it wraps', () => {
  it('does not let the wrapped logger throw into the log call', () => {
    const inner = {
      info(): void {
        throw new Error('transport closed');
      },
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    const logger = redactLogger(inner);
    expect(() => logger.info('m', { a: 1 })).not.toThrow();
    expect(() => logger.warn('m', { password: 'p' })).not.toThrow();
    expect(inner.warn).toHaveBeenCalledWith('m', { password: '[REDACTED]' });
  });
});

/**
 * Both lists are applied to every string the walk reaches. A key list holding
 * a `RegExp` reached `String.prototype.endsWith`, which refuses one outright;
 * a value list holding a string was silently skipped, protecting nothing while
 * the caller believed it did. `redactLogger` already refused both for its own
 * options; the public function they are passed to did not.
 */
describe('redactSecrets refuses a pattern list it cannot apply', () => {
  it.each(['x', null, [/x/], [1]])('names patterns for %p', (patterns) => {
    expectRedactionRefusal(() => redactSecrets({ a: 1 }, patterns as never), 'patterns');
  });

  it.each(['x', null, ['x'], [1]])('names valuePatterns for %p', (valuePatterns) => {
    expectRedactionRefusal(
      () => redactSecrets({ a: 'b' }, undefined, valuePatterns as never),
      'valuePatterns',
    );
  });

  it('accepts an empty list, which is how a caller turns a rule off', () => {
    expect(redactSecrets({ password: 'p' }, [])).toEqual({ password: 'p' });
    expect(redactSecrets({ note: 'token=abc' }, [], [])).toEqual({ note: 'token=abc' });
  });
});

/**
 * `String.prototype.replace` without `g` substitutes only the first match, so a
 * caller-supplied pattern written without the flag redacted the first
 * occurrence of a secret and printed every later one verbatim.
 */
describe('redactText applies a pattern globally whether or not it says so', () => {
  it('redacts every occurrence for a pattern without the g flag', () => {
    expect(redactText('a secret-1 and secret-2 here', [/secret-\d/])).toBe(
      'a [REDACTED] and [REDACTED] here',
    );
  });

  it('skips an entry that is not a RegExp rather than corrupting the text', () => {
    const notAPattern = ['password'] as unknown as RegExp[];
    expect(redactText('harmless text', notAPattern)).toBe('harmless text');
  });
});

describe('redactLogger never throws into the caller', () => {
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

describe('error messages that embed an upstream message', () => {
  it('redacts a credential inside the cause message of a RETRY_EXHAUSTED error', async () => {
    const cause = Object.assign(new Error('connect failed: password=hunter2 host=db'), {
      name: 'ECONNRESET',
    });
    await expect(
      withRetry(
        () => {
          throw cause;
        },
        { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      ),
    ).rejects.toMatchObject({
      name: 'DynamoDBLangGraphError',
      code: ErrorCode.RETRY_EXHAUSTED,
      message: expect.stringContaining('password=[REDACTED]'),
    });
  });

  it('redacts credentials inside both messages of a COMPENSATION_FAILED error', () => {
    const error = compensationFailedError(
      new Error('trigger token=abc123'),
      new Error('rollback secret_access_key=xyz'),
    );
    expect(error.message).not.toContain('abc123');
    expect(error.message).not.toContain('xyz');
    expect(error.message).toContain('[REDACTED]');
  });
});

/**
 * The S3 offload wraps an SDK failure in a public `S3_OFFLOAD_FAILED`. A
 * signing or credential failure reaches it with the credential the SDK tried
 * to sign with quoted in the SDK's own message, so copying that message
 * verbatim puts `aws_secret_access_key=` and `x-amz-security-token=` on
 * `err.message` — the field an application is most likely to print, log or
 * return with no redacting logger anywhere in the path.
 */
describe('the S3 offload never copies an SDK message verbatim', () => {
  const s3Mock = mockClient(S3Client);
  const signingFailure = (): Error =>
    new Error(
      'SignatureDoesNotMatch: signed with aws_secret_access_key=wJalrXUtnFEMIK7MDENG ' +
        'and x-amz-security-token=FQoGZXIvYXdzEBYaDExample',
    );

  const failureOf = async (attempt: Promise<unknown>): Promise<Error> => {
    const outcome = await attempt.then(
      () => undefined,
      (error: Error) => error,
    );
    expect(outcome).toBeDefined();
    return outcome as Error;
  };

  const expectRedacted = (error: Error): void => {
    expect((error as { code?: string }).code).toBe(ErrorCode.S3_OFFLOAD_FAILED);
    expect(error.message).not.toContain('wJalrXUtnFEMIK7MDENG');
    expect(error.message).not.toContain('FQoGZXIvYXdzEBYaDExample');
    expect(error.message).toContain('[REDACTED]');
  };

  afterEach(() => s3Mock.reset());

  it('redacts the credential an upload failure quotes', async () => {
    s3Mock.on(PutObjectCommand).rejects(signingFailure());
    const client = new S3Client({ region: 'us-east-1' });
    const upload = uploadObject(client, { bucket: 'b', key: 'k.bin', data: new Uint8Array([1]) });
    expectRedacted(await failureOf(upload));
  });

  it('redacts the credential a download failure quotes', async () => {
    s3Mock.on(GetObjectCommand).rejects(signingFailure());
    const client = new S3Client({ region: 'us-east-1' });
    expectRedacted(
      await failureOf(downloadObject(client, { bucket: 'b', key: 'k.bin', maxBytes: 1024 })),
    );
  });
});
