/** Marker substituted for anything recognised as secret. */
export const REDACTED = '[REDACTED]';

/** Key names (matched case-insensitively as substrings) whose value is a secret. */
export const DEFAULT_SECRET_KEY_PATTERNS: readonly string[] = [
  'accesskey',
  'secretkey',
  'secret',
  'sessiontoken',
  'securitytoken',
  'authorization',
  'password',
  'apikey',
  'bearer',
  'token',
  'privatekey',
];

/**
 * Secret shapes recognisable in free text, where key-name matching cannot
 * reach: an error's `message`/`stack`, or any other string value. Deliberately
 * high-confidence — each pattern describes a credential *format* rather than a
 * word that merely sounds sensitive — so ordinary operational text survives
 * redaction unchanged.
 *
 * The credential-pair pattern (last) tolerates a **closing quote after the
 * keyword**, because that is what `JSON.stringify` produces
 * (`{"password":"…"}`) and requiring the separator to follow the bare keyword
 * matched nothing at all there — a silent, complete bypass on the single most
 * common shape a downstream HTTP error arrives in. Its group 1 is the keyword
 * and separator, preserved by {@link redactText}.
 *
 * Its value side tries three shapes, and their order is load-bearing:
 * 1. a fully-quoted span that consumes escapes, so `{"password":"a\"b"}` is
 *    redacted whole. Ending the span at the escaped quote stopped the
 *    redaction short and printed the rest of the secret verbatim.
 * 2. an unquoted JSON scalar — number, `true`, `false`, `null` — required to
 *    end at a real delimiter — `,`, `}`, `]` or end of input, optionally
 *    preceded by whitespace. Without this alternative,
 *    `{"apiKey":123,"region":"us-east-1"}` fell through to the fallback below,
 *    which then destroyed every sibling field after the secret. The lookahead
 *    is what stops the alternative truncating a value it does not fully
 *    describe, such as `token=123abc`, and leaking the tail it left behind.
 *    Whitespace alone does not end a scalar: treating a space as a delimiter
 *    made `api_key: 5 items` redact to `api_key: [REDACTED] items`, which
 *    reads as a partial redaction of a value the pattern never described.
 * 3. the rest of the line, so a multi-word secret is redacted whole instead of
 *    up to its first space. Trying the two precise shapes first is what keeps
 *    this fallback from over-redacting sibling JSON fields.
 */
export const DEFAULT_SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /((?:aws_)?(?:secret_access_key|secretaccesskey|password|passwd|api_?key|token)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)(?=\s*[,}\]]|\s*$)|[^\r\n]+)/gi,
];

/** True when `key` matches any secret-key pattern. */
export function isSecretKey(key: string, patterns: readonly string[]): boolean {
  const lower = key.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern));
}

/**
 * Replace every recognised secret shape inside `value` with {@link REDACTED},
 * leaving the surrounding text intact so a redacted message stays readable.
 * Each pattern is rebuilt per call so a `g` flag's `lastIndex` never leaks
 * between invocations.
 *
 * A pattern may capture a leading group it wants **preserved**: only the rest
 * of the match is replaced, which is what keeps `apiKey=[REDACTED]` saying
 * which field was redacted instead of collapsing to a bare marker. A pattern
 * with no group is replaced whole, as before. `String.prototype.replace`
 * passes the match *offset* — a number — as the second callback argument when
 * the pattern has no group, hence the `typeof` test rather than an
 * `undefined` check.
 */
export function redactText(value: string, patterns: readonly RegExp[]): string {
  return patterns.reduce(
    (text, pattern) =>
      text.replace(new RegExp(pattern.source, pattern.flags), (_match, prefix: string | number) =>
        typeof prefix === 'string' ? `${prefix}${REDACTED}` : REDACTED,
      ),
    value,
  );
}

/**
 * A short label for a binary view. Recursing one would explode it into a
 * per-index numeric map, both unreadable and far larger than the value itself.
 */
export function binaryLabel(value: ArrayBufferView): string {
  return `[${value.constructor.name}(${value.byteLength})]`;
}

/** An Error's redacted non-enumerable text, plus whether redaction changed it. */
export interface RedactedErrorText {
  name: string;
  message: string;
  stack: string | undefined;
  changed: boolean;
}

/**
 * Redact an Error's `name`/`message`/`stack`. `changed` reports whether any
 * secret was actually found, which is what decides between passing a bare
 * Error through by reference (preserving its identity and stack trace) and
 * rebuilding it so the secret cannot escape.
 */
export function redactErrorText(error: Error, patterns: readonly RegExp[]): RedactedErrorText {
  const message = redactText(error.message, patterns);
  const stack = error.stack === undefined ? undefined : redactText(error.stack, patterns);
  return {
    name: error.name,
    message,
    stack,
    changed: message !== error.message || stack !== error.stack,
  };
}
