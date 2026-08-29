import { binaryLabel, isSecretKey, REDACTED, redactErrorText } from './secret-patterns';

/** A value that {@link redactSecrets} can recurse through. */
export type Redactable =
  string | number | boolean | null | undefined | Redactable[] | { [key: string]: Redactable };

/** Any `Redactable` that is a non-null object — what the walk dispatches on. */
export type RedactableObject = Redactable[] | { [key: string]: Redactable };

/** One step of the recursive walk, threaded into the entry helpers. */
export type Walk = (value: Redactable) => Redactable;

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

/** True when `value` is an Error (or subclass), tested by tag not `instanceof`. */
function isErrorValue(value: object): value is Error {
  return Object.prototype.toString.call(value) === '[object Error]';
}

/**
 * True for a value whose identity matters more than its own properties.
 * `Date` and `RegExp` have none, so recursing either would yield a bare `{}`.
 */
function isOpaqueValue(value: object): boolean {
  const tag = Object.prototype.toString.call(value);
  return tag === '[object Date]' || tag === '[object RegExp]';
}

/** Rebuild entries into a plain object, redacting values at secret-looking keys. */
function redactEntries(
  entries: readonly (readonly [string, Redactable])[],
  keyPatterns: readonly string[],
  walk: Walk,
): { [key: string]: Redactable } {
  const out: { [key: string]: Redactable } = {};
  for (const [key, value] of entries) {
    out[key] = isSecretKey(key, keyPatterns) ? REDACTED : walk(value);
  }
  return out;
}

/**
 * A Map's entries as an object. Keys are stringified so a non-string key is
 * still reported rather than dropped, and each is checked against the
 * secret-key patterns exactly as a plain object's own keys are.
 */
function redactMap(value: Map<Redactable, Redactable>, deps: WalkDeps): Redactable {
  const entries = [...value].map(([key, entry]): [string, Redactable] => [String(key), entry]);
  return redactEntries(entries, deps.keyPatterns, deps.walk);
}

/**
 * Rebuild an Error as a plain object carrying its redacted text alongside its
 * redacted own properties. The one exception is an Error with no own
 * enumerable data whose text holds no secret: it is returned by reference so
 * its identity and stack trace survive, which is what keeps a caught error
 * useful in a log.
 *
 * `cause` is copied explicitly because `new Error(msg, { cause })` defines it
 * as *non-enumerable* per spec, so `Object.entries` never sees it. Without
 * this the whole chain vanished on every rebuild — and the rebuild always
 * fires for this library's own error types, since each attaches an enumerable
 * `code`/`context`. A redacted `RetryExhaustedError` would then no longer say
 * whether the underlying failure was a throttle, a validation error or a
 * network fault, which is the entire reason it carries a cause. Recursing it
 * through `walk` redacts the chain too, and the cycle guard handles a cause
 * that points back at its own wrapper.
 */
function redactError(
  current: RedactableObject & Error,
  entries: readonly (readonly [string, Redactable])[],
  deps: WalkDeps,
): Redactable {
  const text = redactErrorText(current, deps.valuePatterns);
  if (entries.length === 0 && !text.changed) return current;
  const out = redactEntries(entries, deps.keyPatterns, deps.walk);
  out.name = text.name;
  out.message = text.message;
  out.stack = text.stack;
  if (current.cause !== undefined) out.cause = deps.walk(current.cause as Redactable);
  return out;
}

/**
 * Dispatch one non-null object by its shape: arrays and plain objects recurse,
 * binary views collapse to a label, `Date`/`RegExp` pass through by reference,
 * `Set`/`Map` render as their contents, and an Error takes the path above.
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
