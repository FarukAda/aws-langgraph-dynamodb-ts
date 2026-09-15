import {
  binaryLabel,
  DEFAULT_SECRET_KEY_PATTERNS,
  DEFAULT_SECRET_VALUE_PATTERNS,
  isRegExp,
  isSecretKey,
  normaliseKey,
  REDACTED,
  redactErrorText,
  redactText,
  redactedMessage,
} from '../../../../src/shared/logging/secret-patterns';

describe('normaliseKey', () => {
  it('folds case and drops every separator, so one pattern covers every spelling', () => {
    for (const spelling of ['api_key', 'ApiKey', 'API KEY', 'api.key']) {
      expect(normaliseKey(spelling)).toBe('apikey');
    }
  });

  /**
   * A prefixed name keeps its prefix — `x-api-key` is `xapikey`, not `apikey`.
   * That is precisely why {@link isSecretKey} matches on a suffix.
   */
  it('keeps a prefix, which is what the suffix rule exists for', () => {
    expect(normaliseKey('x-api-key')).toBe('xapikey');
    expect(normaliseKey('aws_secret_access_key')).toBe('awssecretaccesskey');
  });

  it('leaves digits in place and answers empty for a name of separators only', () => {
    expect(normaliseKey('token2')).toBe('token2');
    expect(normaliseKey('---')).toBe('');
  });
});

describe('isSecretKey', () => {
  it('matches a key whose normalised form equals or ends with a pattern', () => {
    expect(isSecretKey('password', DEFAULT_SECRET_KEY_PATTERNS)).toBe(true);
    expect(isSecretKey('secretAccessKey', DEFAULT_SECRET_KEY_PATTERNS)).toBe(true);
    expect(isSecretKey('x-api-key', DEFAULT_SECRET_KEY_PATTERNS)).toBe(true);
    expect(isSecretKey('AUTH_TOKEN', DEFAULT_SECRET_KEY_PATTERNS)).toBe(true);
  });

  /** Suffix, not substring: that distinction is what spares ordinary field names. */
  it('spares a key that merely contains a pattern', () => {
    expect(isSecretKey('maxTokens', DEFAULT_SECRET_KEY_PATTERNS)).toBe(false);
    expect(isSecretKey('tokenizer', DEFAULT_SECRET_KEY_PATTERNS)).toBe(false);
    expect(isSecretKey('secretary', DEFAULT_SECRET_KEY_PATTERNS)).toBe(false);
  });

  it('matches nothing when the caller supplies no patterns', () => {
    expect(isSecretKey('password', [])).toBe(false);
  });
});

describe('isRegExp', () => {
  /** By tag, not instanceof, which answers "no" across a realm or a duplicated module. */
  it('recognises a regular expression and rejects everything else', () => {
    expect(isRegExp(/x/)).toBe(true);
    expect(isRegExp(new RegExp('x'))).toBe(true);
    expect(isRegExp('x' as never)).toBe(false);
    expect(isRegExp({ source: 'x' } as never)).toBe(false);
    expect(isRegExp(undefined as never)).toBe(false);
  });
});

describe('redactedMessage', () => {
  it('redacts a credential the cause happened to carry in its message', () => {
    const error = new Error('SignatureDoesNotMatch: Credential=AKIAIOSFODNN7EXAMPLE/20260101');
    expect(redactedMessage(error)).toContain(REDACTED);
    expect(redactedMessage(error)).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('leaves ordinary operational text alone', () => {
    expect(redactedMessage(new Error('ProvisionedThroughputExceeded on table app'))).toBe(
      'ProvisionedThroughputExceeded on table app',
    );
  });
});

describe('binaryLabel', () => {
  /** Recursing a binary view explodes it into a per-index map, both unreadable and huge. */
  it('labels a binary view by its type and byte length', () => {
    expect(binaryLabel(new Uint8Array(4096))).toBe('[Uint8Array(4096)]');
    expect(binaryLabel(new Float64Array(2))).toBe('[Float64Array(16)]');
    expect(binaryLabel(new Uint8Array(0))).toBe('[Uint8Array(0)]');
  });
});

describe('redactErrorText', () => {
  it('reports changed: false and leaves the text alone when it holds no secret', () => {
    const error = new Error('ordinary failure');
    const text = redactErrorText(error, DEFAULT_SECRET_VALUE_PATTERNS);
    expect(text).toMatchObject({ name: 'Error', message: 'ordinary failure', changed: false });
  });

  /** `changed` is what decides between passing the Error through and rebuilding it. */
  it('reports changed: true when the message held one', () => {
    const error = new Error('password="hunter2"');
    const text = redactErrorText(error, DEFAULT_SECRET_VALUE_PATTERNS);
    expect(text.changed).toBe(true);
    expect(text.message).toContain(REDACTED);
    expect(text.message).not.toContain('hunter2');
  });

  it('redacts the stack too, and carries an absent stack through as absent', () => {
    const error = new Error('boom');
    error.stack = 'at handler (token=abc123secret)';
    expect(redactErrorText(error, DEFAULT_SECRET_VALUE_PATTERNS).stack).toContain(REDACTED);
    const bare = new Error('boom');
    bare.stack = undefined;
    expect(redactErrorText(bare, DEFAULT_SECRET_VALUE_PATTERNS).stack).toBeUndefined();
  });

  it('applies no patterns when given none', () => {
    const error = new Error('password="hunter2"');
    expect(redactErrorText(error, []).changed).toBe(false);
  });
});

describe('redactText with an empty pattern list', () => {
  it('returns the text unchanged', () => {
    expect(redactText('password=hunter2', [])).toBe('password=hunter2');
  });
});
