import type { LogArgument, Logger } from './logger';
import { type Redactable, walkObject } from './redaction-walk';
import {
  DEFAULT_SECRET_KEY_PATTERNS,
  DEFAULT_SECRET_VALUE_PATTERNS,
  normaliseKey,
  redactText,
} from './secret-patterns';

/** Substituted for a log argument whose redaction itself failed (a throwing getter, say). */
const UNREDACTABLE = '[UNREDACTABLE]';

/**
 * Recursively clone `value`, replacing any value at a secret-looking key with
 * `[REDACTED]` and any recognised secret *shape* inside a string — including an
 * error's `message`/`stack` text, which key-name matching cannot reach — with
 * the same marker. Cycles become `[Circular]`.
 *
 * An Error with no own enumerable properties whose text holds no secret is
 * passed through by reference, so its identity and stack trace survive; one
 * carrying own data (this library's error types all attach `code`/`context`
 * this way) or a secret in its text is rebuilt instead, with `name`/`message`/
 * `stack` redacted and every other own property recursed like a plain object.
 * `Date`/`RegExp` keep their identity rather than collapsing to `{}`,
 * `Set`/`Map` render as their contents, and binary views become a short label.
 * Does not mutate the input.
 */
export function redactSecrets(
  value: Redactable,
  patterns: readonly string[] = DEFAULT_SECRET_KEY_PATTERNS,
  valuePatterns: readonly RegExp[] = DEFAULT_SECRET_VALUE_PATTERNS,
): Redactable {
  const seen = new WeakSet<object>();
  const walk = (current: Redactable): Redactable => {
    if (typeof current === 'string') return redactText(current, valuePatterns);
    if (current === null || typeof current !== 'object') return current;
    if (seen.has(current)) return '[Circular]';
    seen.add(current);
    try {
      return walkObject(current, { keyPatterns: patterns, valuePatterns, walk });
    } finally {
      seen.delete(current);
    }
  };
  return walk(value);
}

/** Options controlling {@link redactLogger}. */
export interface RedactLoggerOptions {
  /**
   * Additional key names to redact. Matched like the defaults: a key is
   * redacted when its normalised form (lower-case, punctuation removed) equals
   * or ends with the normalised name, so `'ssn'` covers `SSN` and `user_ssn`.
   */
  extraKeys?: readonly string[];
  /**
   * Additional secret shapes to redact wherever they appear inside a string.
   * A pattern's first capture group, if it has one, is preserved verbatim and
   * only the remainder of the match is replaced.
   */
  extraValuePatterns?: readonly RegExp[];
}

/**
 * Redact one log argument, never throwing: an argument whose redaction fails
 * (a getter that throws, an exotic object) is replaced by a fixed marker rather
 * than either leaking unredacted or failing the library operation that logged.
 */
function safeRedact(
  arg: LogArgument,
  patterns: readonly string[],
  valuePatterns: readonly RegExp[],
): LogArgument {
  try {
    return redactSecrets(arg as Redactable, patterns, valuePatterns) as LogArgument;
  } catch {
    return UNREDACTABLE;
  }
}

/**
 * Wrap a logger so object args are redacted before delegation. The message
 * string is passed through unchanged (never interpolate secrets into it).
 */
export function redactLogger(inner: Logger, options: RedactLoggerOptions = {}): Logger {
  const patterns = options.extraKeys
    ? [...DEFAULT_SECRET_KEY_PATTERNS, ...options.extraKeys.map(normaliseKey)]
    : DEFAULT_SECRET_KEY_PATTERNS;
  const valuePatterns = options.extraValuePatterns
    ? [...DEFAULT_SECRET_VALUE_PATTERNS, ...options.extraValuePatterns]
    : DEFAULT_SECRET_VALUE_PATTERNS;
  const wrap = (args: LogArgument[]): LogArgument[] =>
    args.map((arg) => safeRedact(arg, patterns, valuePatterns));
  return {
    info: (message, ...args) => inner.info(message, ...wrap(args)),
    warn: (message, ...args) => inner.warn(message, ...wrap(args)),
    error: (message, ...args) => inner.error(message, ...wrap(args)),
    debug: (message, ...args) => inner.debug(message, ...wrap(args)),
  };
}
