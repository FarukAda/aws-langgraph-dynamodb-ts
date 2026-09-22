import {
  MAX_LOGGED_VALUE_CHARS,
  MAX_RELAYED_MESSAGE_CHARS,
} from '../../../../src/shared/constants';
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
import { truncateRelayedText } from '../../../../src/shared/logging/truncate';

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

  /**
   * The bound lives here rather than at the sites that quote the result, so
   * every relay inherits it. The value worth bounding is not the SDK's text
   * but a caller's own: a `serde` refusal or a `vectorBackend` rejection whose
   * length the caller controls entirely, quoted on paths that walk a whole
   * prefix or table.
   */
  it('cuts a caller-controlled message at the relay cap and states its real length', () => {
    const caller = 'z'.repeat(MAX_RELAYED_MESSAGE_CHARS * 4);
    const out = redactedMessage(new Error(caller));
    expect(out).toBe(truncateRelayedText(caller));
    expect(out).toContain(`…(len ${caller.length})`);
    expect(out.length).toBeLessThan(caller.length);
  });

  /**
   * Cutting before redacting would split a credential shape past the pattern
   * that catches it and print the head verbatim, so the order is load-bearing
   * — and only a secret that *straddles* the cut can show it. A secret wholly
   * before the boundary survives either order, since the cut never touches it
   * and the redaction catches it whichever runs first; this one is placed so
   * the marker ends exactly at the cut and the raw key would not, which makes
   * the two orders disagree in both directions at once.
   */
  it('redacts before it cuts, so a secret astride the cut cannot survive it', () => {
    const key = 'AKIAIOSFODNN7EXAMPLE';
    const head = `${'x'.repeat(MAX_RELAYED_MESSAGE_CHARS - REDACTED.length - 1)} `;
    const out = redactedMessage(new Error(`${head}${key} tail`));
    expect(out).toContain(REDACTED);
    /** Cutting first leaves exactly this head, which no pattern then matches. */
    expect(out).not.toContain(key.slice(0, REDACTED.length));
  });

  /** Prose, not an identifier: a real AWS diagnostic is longer than a key and survives whole. */
  it('relays a diagnostic past the identifier cap intact', () => {
    const denied = `AccessDenied: ${'arn:aws:iam::123456789012:role/App '.repeat(8)}`;
    expect(denied.length).toBeGreaterThan(MAX_LOGGED_VALUE_CHARS);
    expect(redactedMessage(new Error(denied))).toBe(denied);
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
