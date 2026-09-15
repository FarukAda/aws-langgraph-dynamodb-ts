import { ValidationError } from '../errors/errors';
import type { LogArgument, Logger } from './logger';
import { type Redactable, walkObject } from './redaction-walk';
import {
  DEFAULT_SECRET_KEY_PATTERNS,
  DEFAULT_SECRET_VALUE_PATTERNS,
  isRegExp,
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
 *
 * Accepts: `value` — any log argument, including `undefined`, a primitive, a
 * typed `Error`, a class instance or a `Record`, so callers never cast. A
 * cyclic or shared graph is fine; each node is walked once. `patterns` and
 * `valuePatterns` — the key names and value shapes to redact; both default to
 * this package's own lists, and an entry of `valuePatterns` that is not a
 * `RegExp` is skipped.
 *
 * Returns: a redacted clone. The input is never mutated — a logger that
 * scrubbed the caller's own object would corrupt the very data the application
 * is working with.
 *
 * Throws: nothing. A node whose own redaction fails — a throwing getter, a
 * structure deep enough to exhaust the stack — becomes `[UNREDACTABLE]`, since
 * a logger that throws takes down the operation it was only observing.
 */
export function redactSecrets(
  value: LogArgument | undefined,
  patterns: readonly string[] = DEFAULT_SECRET_KEY_PATTERNS,
  valuePatterns: readonly RegExp[] = DEFAULT_SECRET_VALUE_PATTERNS,
): Redactable {
  /**
   * `walking` detects a cycle; `done` memoises a finished node. Both are
   * needed and they answer different questions. A guard that only removed a
   * node when its subtree finished is correct for cycles but re-walks every
   * node reachable by more than one path, so a graph that merely *shares*
   * structure — not even a cycle — costs exponential time: a few dozen shared
   * objects in a sub-kilobyte argument blocked the event loop for minutes, and
   * this is a public export reachable from caller code.
   */
  const walking = new WeakSet<object>();
  const done = new WeakMap<object, Redactable>();
  const walk = (current: Redactable): Redactable => {
    if (typeof current === 'string') return redactText(current, valuePatterns);
    if (current === null || typeof current !== 'object') return current;
    if (done.has(current)) return done.get(current) as Redactable;
    if (walking.has(current)) return '[Circular]';
    walking.add(current);
    try {
      const redacted = walkObject(current, { keyPatterns: patterns, valuePatterns, walk });
      done.set(current, redacted);
      return redacted;
    } finally {
      walking.delete(current);
    }
  };
  try {
    return walk(value as Redactable);
  } catch (error) {
    /**
     * Nesting deep enough to exhaust the stack yields the same marker the
     * wrapped logger substitutes, rather than a `RangeError` thrown at a
     * caller who only asked for a redacted copy. Every other failure is the
     * caller's to see.
     */
    if ((error as Error | undefined)?.name === 'RangeError') return UNREDACTABLE;
    throw error;
  }
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
    return redactSecrets(arg, patterns, valuePatterns) as LogArgument;
  } catch {
    return UNREDACTABLE;
  }
}

/**
 * Reject redaction options that would silently fail to redact.
 *
 * A non-string in `extraKeys` reached `key.toLowerCase()` and raised a bare
 * `TypeError` at the first log call; a non-`RegExp` in `extraValuePatterns` is
 * skipped by {@link redactText} and would have protected nothing while the
 * caller believed it did. Both are refused here, once, where they are
 * configured.
 */
function assertRedactionOptions(options: RedactLoggerOptions): void {
  for (const key of options.extraKeys ?? []) {
    if (typeof key !== 'string') {
      throw new ValidationError('every extraKeys entry must be a string', 'extraKeys');
    }
  }
  for (const pattern of options.extraValuePatterns ?? []) {
    if (!isRegExp(pattern)) {
      throw new ValidationError(
        'every extraValuePatterns entry must be a RegExp',
        'extraValuePatterns',
      );
    }
  }
}

/**
 * Wrap a logger so object args are redacted before delegation.
 *
 * Accepts: `inner` — the logger to delegate to. `options.extraKeys` — further
 * key names to redact, matched like the defaults. `options.extraValuePatterns`
 * — further secret shapes; each must be a `RegExp`, and it is applied globally
 * whether or not it carries the `g` flag.
 *
 * Returns: a logger with the same four methods.
 *
 * Throws: ValidationError naming `extraKeys` or `extraValuePatterns` for an
 * entry of the wrong type. Nothing at log time: an argument whose redaction
 * fails is replaced by a fixed marker rather than failing the library
 * operation that logged it.
 *
 * Guarantees: the message string is passed through unchanged — never
 * interpolate a secret into it — and every other argument is redacted before
 * it reaches `inner`.
 */
export function redactLogger(inner: Logger, options: RedactLoggerOptions = {}): Logger {
  assertRedactionOptions(options);
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
