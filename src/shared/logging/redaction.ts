import { validationError } from '../errors/errors';
import { assertMembers, LOGGER_MEMBERS } from '../validation/collaborators';
import { assertObjectShape } from '../validation/option-shape';
import { validateStringArray } from '../validation/primitives';
import { absorbLoggerFailure, type LogArgument, type Logger } from './logger';
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
 * Reject a list of value shapes this package could not apply.
 *
 * Accepts: `value` — the list as the caller gave it. `field` — what the error
 * names.
 *
 * Returns: nothing; validity is the absence of a throw. An empty list is
 * valid, and is how a caller turns value matching off.
 *
 * Throws: ValidationError naming `field` for a non-array or an entry that is
 * not a `RegExp`. {@link redactText} skips such an entry, which protects
 * nothing while the caller believes it does, so it is refused where it is
 * supplied instead.
 */
function assertRegExpArray(value: readonly RegExp[], field: string): void {
  if (!Array.isArray(value) || value.some((entry: RegExp) => !isRegExp(entry))) {
    throw validationError(`${field} must be an array of RegExp`, field);
  }
}

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
 * `valuePatterns` — the key names and value shapes to redact, an array of
 * strings and an array of `RegExp` respectively; both default to this
 * package's own lists, and an empty one turns that rule off.
 *
 * Returns: a redacted clone. The input is never mutated — a logger that
 * scrubbed the caller's own object would corrupt the very data the application
 * is working with.
 *
 * Throws: ValidationError naming `patterns` or `valuePatterns` for a list this
 * function could not apply, which is a mistake in the call itself and is
 * raised before anything is walked. Nothing after that: a value whose
 * redaction fails — a throwing getter, a structure deep enough to exhaust the
 * stack — is replaced whole by `[UNREDACTABLE]`, since a logger that throws
 * takes down the operation it was only observing. {@link redactLogger}
 * redacts one argument per call, so there a single hostile argument is what is
 * lost rather than the record around it.
 */
export function redactSecrets(
  value: LogArgument | undefined,
  patterns: readonly string[] = DEFAULT_SECRET_KEY_PATTERNS,
  valuePatterns: readonly RegExp[] = DEFAULT_SECRET_VALUE_PATTERNS,
): Redactable {
  validateStringArray(patterns, 'patterns');
  assertRegExpArray(valuePatterns, 'valuePatterns');
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
    if (done.has(current)) return done.get(current);
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
  } catch {
    /**
     * Every failure of the walk yields the marker: a `RangeError` from nesting
     * deeper than the stack holds, and equally a getter of the caller's own
     * that throws. Telling the two apart served no caller. The value is being
     * prepared for a log line, and the log line is typically written from a
     * `catch`, so a throw here does not report the hostile value — it replaces
     * the failure that was being reported with a `TypeError` about a getter.
     */
    return UNREDACTABLE;
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
 * Reject redaction options that would silently fail to redact.
 *
 * A non-string in `extraKeys` reached `key.toLowerCase()` and raised a bare
 * `TypeError` at the first log call; a non-`RegExp` in `extraValuePatterns` is
 * skipped by {@link redactText} and would have protected nothing while the
 * caller believed it did. An `options` that is not an object at all carried no
 * rule to begin with, and was read as "none given", leaving the caller running
 * on a default it believed it had overridden. All three are refused here,
 * once, where they are configured.
 */
function assertRedactionOptions(options: RedactLoggerOptions): void {
  assertObjectShape(options, 'options');
  if (options.extraKeys !== undefined) validateStringArray(options.extraKeys, 'extraKeys');
  if (options.extraValuePatterns !== undefined) {
    assertRegExpArray(options.extraValuePatterns, 'extraValuePatterns');
  }
}

/**
 * Wrap a logger so object args are redacted before delegation.
 *
 * Accepts: `inner` — the logger to delegate to; it must carry all four
 * methods, because a missing one is a wiring mistake worth naming here rather
 * than at the first log line. `options.extraKeys` — further key names to
 * redact, matched like the defaults. `options.extraValuePatterns` — further
 * secret shapes; each must be a `RegExp`, and it is applied globally whether or
 * not it carries the `g` flag.
 *
 * Returns: a logger with the same four methods.
 *
 * Throws: ValidationError naming `logger` or `logger.<method>` for a logger it
 * could not delegate to, and `options`, `extraKeys` or `extraValuePatterns`
 * for an option of the wrong type. Nothing at log time.
 *
 * Guarantees: the message string is passed through unchanged — never
 * interpolate a secret into it — and every other argument is redacted before
 * it reaches `inner`. Past the wrap call nothing escapes a log call: an
 * argument whose redaction fails is replaced by a fixed marker, and a failure
 * of `inner` itself is absorbed (`absorbLoggerFailure`), because the
 * operation that wrote the line was only observing itself and is commonly
 * reporting some other failure already.
 */
export function redactLogger(inner: Logger, options: RedactLoggerOptions = {}): Logger {
  assertMembers(inner, LOGGER_MEMBERS, 'logger');
  assertRedactionOptions(options);
  const patterns = options.extraKeys
    ? [...DEFAULT_SECRET_KEY_PATTERNS, ...options.extraKeys.map(normaliseKey)]
    : DEFAULT_SECRET_KEY_PATTERNS;
  const valuePatterns = options.extraValuePatterns
    ? [...DEFAULT_SECRET_VALUE_PATTERNS, ...options.extraValuePatterns]
    : DEFAULT_SECRET_VALUE_PATTERNS;
  const deliver =
    (method: keyof Logger) =>
    (message: string, ...args: LogArgument[]): void =>
      absorbLoggerFailure(() =>
        inner[method](
          message,
          ...args.map((arg) => redactSecrets(arg, patterns, valuePatterns) as LogArgument),
        ),
      );
  return {
    info: deliver('info'),
    warn: deliver('warn'),
    error: deliver('error'),
    debug: deliver('debug'),
  };
}
