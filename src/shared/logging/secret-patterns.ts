import { toError } from '../errors/base-error';
import { truncateRelayedText } from './truncate';

/** Marker substituted for anything recognised as secret. */
export const REDACTED = '[REDACTED]';

/**
 * Key names whose value is a secret. Each entry is a *normalised* name — see
 * {@link normaliseKey} — and matches a key whose normalised form equals it or
 * ends with it. Suffix matching is what catches `secretAccessKey`, `x-api-key`,
 * `client_secret` and `AUTH_TOKEN`; requiring the pattern to be a suffix, not a
 * substring, is what spares `maxTokens`, `total_tokens`, `tokenizer` and
 * `secretary`, which the old substring rule redacted.
 */
export const DEFAULT_SECRET_KEY_PATTERNS: readonly string[] = [
  'accesskey',
  'accesskeyid',
  'secret',
  'sessiontoken',
  'securitytoken',
  'authorization',
  'password',
  'passwd',
  'passphrase',
  'apikey',
  'bearer',
  'token',
  'privatekey',
];

/**
 * Canonical form of a key name for matching.
 *
 * Accepts: any key name, in any case and with any separators.
 *
 * Returns: it lower-cased with every character that is not a letter or digit
 * removed, so `api_key`, `x-api-key`, `ApiKey` and `API KEY` all become
 * `apikey` and one pattern covers every spelling.
 *
 * Throws: nothing.
 */
export function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

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

/**
 * Whether a key name says its value is a secret.
 *
 * Accepts: `key` — any name. `patterns` — already-normalised names; an empty
 * list matches nothing, which is how a caller turns key matching off.
 *
 * Returns: whether the normalised key equals or *ends with* a pattern. Suffix,
 * not substring: that is what catches `secretAccessKey` and `x-api-key` while
 * sparing `maxTokens`, `tokenizer` and `secretary`.
 *
 * Throws: nothing.
 */
export function isSecretKey(key: string, patterns: readonly string[]): boolean {
  const normalised = normaliseKey(key);
  return patterns.some((pattern) => normalised === pattern || normalised.endsWith(pattern));
}

/**
 * An error's message with recognised credential shapes redacted.
 *
 * Accepts: any error — and, since this is what a `catch` block binds, any
 * other value a `throw` can produce: `null`, `undefined`, a string, a number,
 * a symbol, a plain object. Such a value is described through {@link toError}
 * first and the description is what is redacted, so a secret it carries in its
 * own text is still caught.
 *
 * Returns: the message, redacted with the default value patterns and then
 * bounded by `truncateRelayedText` — for embedding in another error's
 * message, since a wrapper that quotes its cause must not leak a `password=`
 * or token the cause happened to carry. That text reaches `err.message`, which
 * an application may print without a redacting logger.
 *
 * The bound is here rather than at the sites that quote the result, so no call
 * site can get it wrong and no future one has to remember: a `RETRY_EXHAUSTED`
 * report, a wrapped AWS failure, a compensation failure and both S3 transfer
 * errors all inherit it from this one line. Redaction runs **before** the cut,
 * because cutting first could split a credential shape past the pattern that
 * would have caught it. Its own cap rather than the identifier cap: this is
 * prose, and `MAX_RELAYED_MESSAGE_CHARS` records what that number is
 * measured against. The value worth bounding is not the AWS SDK's own text but
 * a **caller's** — a `serde` refusal or a `vectorBackend` rejection, whose
 * length the caller controls entirely and which some paths quote once per row.
 *
 * Throws: **nothing**, for any value. Reading `.message` off a thrown
 * primitive yielded `undefined` and the redaction then raised a `TypeError` —
 * from inside the `catch` that was reporting the real failure, and from the
 * one function a static guard funnels every one of this package's `catch`
 * blocks into. Its promise has to hold for what a `catch` actually binds, or
 * the guard concentrates every site into a function that is not safe.
 */
export function redactedMessage(error: Error): string {
  return truncateRelayedText(redactText(toError(error).message, DEFAULT_SECRET_VALUE_PATTERNS));
}

/**
 * A fresh, global copy of `pattern`.
 *
 * Rebuilt per call so a `g` flag's `lastIndex` never leaks between
 * invocations, and **forced** global: `String.prototype.replace` without `g`
 * substitutes only the first match, so a caller-supplied pattern written
 * without the flag would redact the first occurrence of a secret and print
 * every later one verbatim.
 */
function globalCopyOf(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

/**
 * Whether `value` is a regular expression.
 *
 * Accepts: anything, including a `RegExp` from another realm.
 *
 * Returns: whether its tag says so. By tag rather than `instanceof`, which is
 * banned repo-wide because it answers "no" across a realm or a duplicated
 * module.
 *
 * Throws: nothing.
 */
export function isRegExp(value: RegExp): boolean {
  return Object.prototype.toString.call(value) === '[object RegExp]';
}

/**
 * Replace every recognised secret shape inside `value` with {@link REDACTED},
 * leaving the surrounding text intact so a redacted message stays readable.
 *
 * Accepts: `value` — any text. `patterns` — applied in order, each against the
 * result of the last; an empty list returns the text unchanged. An entry that
 * is not a `RegExp` is skipped: reading `.source` off one produced
 * `new RegExp(undefined)` — that is `/(?:)/`, which matches the empty string
 * and prefixed the marker to every value while catching no secret at all.
 * Both public entry points — `redactSecrets` and {@link redactLogger} — now
 * refuse such an entry where it is supplied, since a skipped pattern protects
 * nothing while its caller believes it does; skipping remains the last-ditch
 * guard for a list this package assembles internally.
 *
 * Returns: the text with every match replaced. A pattern may capture a leading
 * group it wants **preserved**: only the rest of the match is replaced, which
 * keeps `apiKey=[REDACTED]` saying which field was redacted instead of
 * collapsing to a bare marker. A pattern with no group is replaced whole.
 * `String.prototype.replace` passes the match *offset* — a number — as the
 * second callback argument when the pattern has no group, hence the `typeof`
 * test rather than an `undefined` check.
 *
 * Throws: nothing.
 *
 * Guarantees: every pattern is applied globally and from a fresh copy, so
 * neither a missing `g` flag nor a leftover `lastIndex` can leave a later
 * occurrence in the clear.
 */
export function redactText(value: string, patterns: readonly RegExp[]): string {
  return patterns.reduce((text, pattern) => {
    if (!isRegExp(pattern)) return text;
    return text.replace(globalCopyOf(pattern), (_match, prefix: string | number) =>
      typeof prefix === 'string' ? `${prefix}${REDACTED}` : REDACTED,
    );
  }, value);
}

/**
 * A short label for a binary view.
 *
 * Accepts: any `ArrayBufferView`.
 *
 * Returns: its type and byte length, e.g. `[Uint8Array(4096)]`. Recursing into
 * one would explode it into a per-index numeric map, both unreadable and far
 * larger than the value itself — and a payload is exactly the thing a log must
 * not carry.
 *
 * Throws: nothing.
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
 * Redact an Error's `name`, `message` and `stack`.
 *
 * Accepts: `error` — any error; a missing `stack` stays missing. Any other
 * value a `throw` can produce is described through {@link toError} first, on
 * the same reasoning as {@link redactedMessage}: the walk that calls this only
 * reaches it for a value whose tag says `Error`, but the promise below is
 * written in this function's own contract and is this function's to keep.
 *
 * Returns: the redacted text, plus `changed`: whether any secret was actually
 * found. That flag is what decides between passing a bare Error through by
 * reference — preserving its identity and stack trace — and rebuilding it so
 * the secret cannot escape. It compares against the described error, so a
 * value that had no text of its own is never reported as changed by the
 * describing.
 *
 * None of the three is cut, and that is a decision rather than an omission.
 * The rule that bounds unchecked text bounds what *this package* writes into
 * its own `err.message` and its own log lines — `redactedMessage` is that
 * funnel. This function is on the other side of the boundary: it rebuilds an
 * Error the **consumer** handed to `redactSecrets`, or to the logger
 * `redactLogger` wrapped, on the way to the consumer's own transport. Cutting
 * there would change what their transport receives, for a value this package
 * neither produced nor quotes, and the caller asked for redaction rather than
 * for truncation. A consumer who wants a bound has their own transport to put
 * one in.
 *
 * Throws: **nothing**, for any value.
 */
export function redactErrorText(error: Error, patterns: readonly RegExp[]): RedactedErrorText {
  const described = toError(error);
  const message = redactText(described.message, patterns);
  const stack = described.stack === undefined ? undefined : redactText(described.stack, patterns);
  return {
    name: described.name,
    message,
    stack,
    changed: message !== described.message || stack !== described.stack,
  };
}
