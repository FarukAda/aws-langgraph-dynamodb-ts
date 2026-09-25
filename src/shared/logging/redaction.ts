/**
 * Hides how a logger and a value are redacted.
 *
 * A redacting logger walks every argument of every line, bounded in depth and
 * safe against cycles and hostile getters, and replaces the value of any key
 * that looks like a secret and any text that looks like one; the same walk
 * serves `redactSecrets` for a value a caller wants to log themselves.
 */

import { validationError } from '../errors/errors';
import { assertMembers, LOGGER_MEMBERS } from '../validation/collaborators';
import { assertObjectShape } from '../validation/option-shape';
import { assertStringArray } from '../validation/primitives';
import { absorbLoggerFailure, type LogArgument, type Logger } from './logger';
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
} from './secret-patterns';

/** Substituted for a log argument whose redaction itself failed (a throwing getter, say). */
const UNREDACTABLE = '[UNREDACTABLE]';

/**
 * Reject a list of value shapes this package could not apply.
 *
 * Accepts: `value` — the list as the caller gave it. `field` — what the error
 * names.
 *
 * Returns: nothing: the value is kept under its declared type, and this
 * checks it. An empty list is valid, and is how a caller turns value matching
 * off.
 *
 * Throws: `VALIDATION` naming `field` for a non-array or an entry that is
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
 * Throws: `VALIDATION` naming `patterns` or `valuePatterns` for a list this
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
  assertStringArray(patterns, 'patterns');
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
 *
 * Accepts: `options` — as the caller gave it.
 *
 * Returns: nothing: the value is kept under its declared type, and this
 * checks it.
 *
 * Throws: `VALIDATION` naming `options`, `extraKeys` or `extraValuePatterns`.
 */
function assertRedactionOptions(options: RedactLoggerOptions): void {
  assertObjectShape(options, 'options');
  if (options.extraKeys !== undefined) assertStringArray(options.extraKeys, 'extraKeys');
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
 * Throws: `VALIDATION` naming `logger` or `logger.<method>` for a logger it
 * could not delegate to, and `options`, `extraKeys` or `extraValuePatterns`
 * for an option of the wrong type. Nothing at log time.
 *
 * Guarantees: the message string is passed through unchanged — never
 * interpolate a secret into it — and every other argument is redacted before
 * it reaches `inner`. Past the wrap call nothing escapes a log call: an
 * argument whose redaction fails is replaced by a fixed marker, and a failure
 * of `inner` itself is absorbed, because the
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

/** A value that {@link redactSecrets} can recurse through. */
export type Redactable =
  string | number | boolean | null | undefined | Redactable[] | { [key: string]: Redactable };

/** Any `Redactable` that is a non-null object — what the walk dispatches on. */
export type RedactableObject = Redactable[] | { [key: string]: Redactable };

/** One step of the recursive walk, threaded into the entry helpers. */
type Walk = (value: Redactable) => Redactable;

/** Collaborators threaded through the recursive walk. */
export interface WalkDeps {
  keyPatterns: readonly string[];
  valuePatterns: readonly RegExp[];
  walk: Walk;
}

/** True when `value` is a Set, tested by tag so a cross-realm Set still matches. */
function isSetValue(value: object): value is Set<Redactable> {
  return Object.prototype.toString.call(value) === '[object Set]';
}

/** True when `value` is a Map, tested by tag so a cross-realm Map still matches. */
function isMapValue(value: object): value is Map<Redactable, Redactable> {
  return Object.prototype.toString.call(value) === '[object Map]';
}

/**
 * True when `value` is an Error (or subclass) or a `DOMException` — which has
 * its own tag yet carries the same `name`/`message`/`stack` — tested by tag,
 * not `instanceof`, so a cross-realm error still matches.
 */
function isErrorValue(value: object): value is Error {
  const tag = Object.prototype.toString.call(value);
  return tag === '[object Error]' || tag === '[object DOMException]';
}

/**
 * True for a value whose identity matters more than its own properties.
 * `Date` and `RegExp` have none, so recursing either would yield a bare `{}`.
 */
function isOpaqueValue(value: object): boolean {
  const tag = Object.prototype.toString.call(value);
  return tag === '[object Date]' || tag === '[object RegExp]';
}

/**
 * Rebuild entries into a plain object, redacting values at secret-looking
 * keys. Properties are defined, not assigned: `out['__proto__'] = …` would
 * replace the result's prototype (and drop the entry) instead of recording the
 * key as data.
 */
function redactEntries(
  entries: readonly (readonly [string, Redactable])[],
  keyPatterns: readonly string[],
  walk: Walk,
): { [key: string]: Redactable } {
  const out: { [key: string]: Redactable } = {};
  for (const [key, value] of entries) {
    Object.defineProperty(out, key, {
      value: isSecretKey(key, keyPatterns) ? REDACTED : walk(value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * A Map's entries as an object. Keys are stringified so a non-string key is
 * still reported rather than dropped — including as `[object Object]` for a
 * plain-object key, which beats silently losing the entry — and each is
 * checked against the secret-key patterns exactly as a plain object's own
 * keys are.
 *
 * The annotation on `keyText` is `Redactable`'s own shape restated with an
 * explicit `toString`, which every one of its members already has; it changes
 * nothing about which key is what, only what `no-base-to-string` can see, so
 * it stops mistaking the deliberate `[object Object]` case above for a bug.
 */
function redactMap(value: Map<Redactable, Redactable>, deps: WalkDeps): Redactable {
  const entries = [...value].map(([key, entry]): [string, Redactable] => {
    const keyText: { toString(): string } | null | undefined = key;
    return [String(keyText), entry];
  });
  return redactEntries(entries, deps.keyPatterns, deps.walk);
}

/**
 * Rebuild an Error as a plain object carrying its redacted text alongside its
 * redacted own properties. The one exception is an Error with no own
 * enumerable data, no `cause`, no aggregated `errors`, and no secret in its
 * text: it is returned by reference so its identity and stack trace survive,
 * which is what keeps a caught error useful in a log.
 *
 * `cause` and `AggregateError.errors` are copied explicitly because both are
 * defined *non-enumerable* per spec, so `Object.entries` never sees them.
 * Without this the whole chain vanished on every rebuild — and the rebuild
 * always fires for this library's own error types, since each attaches an
 * enumerable `code`/`context`. A redacted `RETRY_EXHAUSTED` would then no
 * longer say whether the underlying failure was a throttle, a validation error
 * or a network fault, which is the entire reason it carries a cause. A bare
 * Error *with* a cause is rebuilt for the same reason: passing it by reference
 * would hand the caller whatever secret the cause carries. Recursing through
 * `walk` redacts the chain too, and the cycle guard handles a cause that
 * points back at its own wrapper.
 */
function redactError(
  current: RedactableObject & Error,
  entries: readonly (readonly [string, Redactable])[],
  deps: WalkDeps,
): Redactable {
  const text = redactErrorText(current, deps.valuePatterns);
  const aggregated = (current as { errors?: Redactable[] }).errors;
  const bare = entries.length === 0 && current.cause === undefined && aggregated === undefined;
  if (bare && !text.changed) return current;
  const out = redactEntries(entries, deps.keyPatterns, deps.walk);
  out.name = text.name;
  out.message = text.message;
  out.stack = text.stack;
  if (current.cause !== undefined) out.cause = deps.walk(current.cause as Redactable);
  if (Array.isArray(aggregated)) out.errors = deps.walk(aggregated);
  return out;
}

/**
 * Dispatch one non-null object by its shape.
 *
 * Accepts: `current` — any object. `deps.walk` — how to recurse, which carries
 * the cycle and memo state this module deliberately does not own.
 *
 * Returns: the redacted form — arrays and plain objects recursed, binary views
 * collapsed to a label, `Date`/`RegExp` passed through by reference so they do
 * not become `{}`, `Set`/`Map` rendered as their contents, and an Error through
 * the error path, which preserves the non-enumerable text a plain walk cannot
 * see.
 *
 * Throws: whatever a property getter on the value throws. `redactSecrets`, the
 * only caller, catches it and returns `[UNREDACTABLE]` in place of the whole
 * value it was given, rather than raising a getter's error at a caller who
 * asked only for a copy it could log.
 */
export function walkObject(current: RedactableObject, deps: WalkDeps): Redactable {
  if (Array.isArray(current)) return current.map(deps.walk);
  if (ArrayBuffer.isView(current)) return binaryLabel(current);
  if (isOpaqueValue(current)) return current;
  if (isSetValue(current)) return [...current].map(deps.walk);
  if (isMapValue(current)) return redactMap(current, deps);
  const entries = Object.entries(current);
  if (isErrorValue(current)) return redactError(current, entries, deps);
  return redactEntries(entries, deps.keyPatterns, deps.walk);
}
