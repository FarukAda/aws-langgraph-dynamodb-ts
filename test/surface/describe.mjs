/**
 * Renders a fuzz input as the label that names its case in the surface
 * baseline, and a returned value as the text of its outcome.
 *
 * The label is all that tells two cases apart in the baseline, so distinct
 * inputs must not render alike. `JSON.stringify` could not promise that: NaN,
 * both infinities and an Invalid Date all became `null`; a `Map`, a `RegExp`
 * and an `Error` all became `{}`; a cycle and a throwing getter fell back to
 * one shared token; a fixed cut left long inputs sharing a prefix; and a
 * C1 control character passed through raw, invisible in a terminal or a diff.
 *
 * So each value renders by kind, with bare tokens (`fn`, `<undef>`, `NaN`) for
 * what JSON cannot express, and a label over {@link MAX_LABEL} keeps a readable
 * prefix plus a hash of the whole rendering. Everything is derived from the
 * value's content — no object identity, clock, randomness or locale — because
 * CI compares the baseline byte for byte against one generated on another OS.
 *
 * Known limits, where distinct values still render alike: two functions (both
 * `fn`), two unregistered symbols with one description, two instances of a
 * class nested inside another value (named, not expanded), and structure below
 * {@link MAX_DEPTH}. The uniqueness test in `surface.test.mjs` fails on any of
 * them that reaches the case list.
 */
import { createHash } from 'node:crypto';

/**
 * Longest label kept whole; a longer one keeps a prefix and gains a hash. Wide
 * enough that an options object differing only in its last key still shows
 * that key, rather than a shared prefix told apart by nothing but its hash.
 */
const MAX_LABEL = 90;

/** Longest string kept whole wherever it appears in a label. */
const MAX_STRING = 40;

/** Nesting rendered before a value becomes `<deep>`; bounds recursion on a deeply nested input. */
const MAX_DEPTH = 32;

/** Built at runtime so this file holds no escape text for a tool to decode. */
const BACKSLASH = String.fromCharCode(92);

const isHigh = (unit) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit) => unit >= 0xdc00 && unit <= 0xdfff;

/** First 8 hex digits of SHA-256 over the text's UTF-8 bytes; the text must hold no lone surrogate. */
const hashOf = (text) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);

/**
 * Replace every code unit a reader cannot see — C0 controls, DEL, C1 controls
 * and lone surrogates — with its four-hex-digit escape. `JSON.stringify` covers
 * C0 and lone surrogates inside a string but leaves DEL and C1 controls raw, and other
 * kinds (a RegExp's source) are not stringified at all. A lone surrogate left
 * raw would also be written to the baseline as U+FFFD, silently changing it.
 */
function visible(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (isHigh(unit) && isLow(text.charCodeAt(i + 1))) {
      out += text.slice(i, i + 2);
      i += 1;
    } else if (unit < 0x20 || (unit >= 0x7f && unit <= 0x9f) || isHigh(unit) || isLow(unit)) {
      out += `${BACKSLASH}u${unit.toString(16).padStart(4, '0')}`;
    } else {
      out += text[i];
    }
  }
  return out;
}

/** The first `length` code units, one fewer when the cut would split a surrogate pair. */
function cut(text, length) {
  return isHigh(text.charCodeAt(length - 1)) ? text.slice(0, length - 1) : text.slice(0, length);
}

function renderString(value) {
  if (value.length <= MAX_STRING) return JSON.stringify(value);
  const whole = hashOf(visible(JSON.stringify(value)));
  return JSON.stringify(`${value.slice(0, 20)}…(len ${value.length} #${whole})`);
}

function renderSymbol(value) {
  const key = Symbol.keyFor(value);
  if (key !== undefined) return `Symbol.for(${JSON.stringify(key)})`;
  return value.description === undefined ? 'Symbol()' : `Symbol(${JSON.stringify(value.description)})`;
}

/** A Date to the day when it falls on UTC midnight, to the millisecond otherwise. */
function renderDate(value) {
  if (Number.isNaN(Date.prototype.getTime.call(value))) return 'Invalid';
  const iso = Date.prototype.toISOString.call(value);
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
}

/** A property's value, or `<throws>` when reading it throws (a getter). */
function readProperty(object, key, ancestors) {
  let value;
  try {
    value = object[key];
  } catch {
    return '<throws>';
  }
  return value === undefined ? '<undef>' : render(value, ancestors);
}

function renderProperties(object, ancestors) {
  const enumerableSymbols = Object.getOwnPropertySymbols(object).filter((symbol) =>
    Object.prototype.propertyIsEnumerable.call(object, symbol),
  );
  const entries = [
    ...Object.keys(object).map((key) => `${JSON.stringify(key)}:${readProperty(object, key, ancestors)}`),
    ...enumerableSymbols.map((symbol) => `[${renderSymbol(symbol)}]:${readProperty(object, symbol, ancestors)}`),
  ];
  return `{${entries.join(',')}}`;
}

function constructorName(prototype) {
  const ctor = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
  return typeof ctor === 'function' && ctor.name ? ctor.name : '<anonymous>';
}

/**
 * The inside of `Name(…)` for an instance of a class. Built-in value types
 * render their content, found by their internal tag rather than `instanceof`.
 * A class instance nested inside another value renders as `…`: there it is
 * almost always wiring — an SDK client, a logger — whose properties belong to
 * a dependency, change with its version and can read the environment.
 */
function renderInstance(value, ancestors) {
  const nested = (inner) => render(inner, ancestors);
  const tag = Object.prototype.toString.call(value).slice(8, -1);
  if (tag === 'Date') return renderDate(value);
  if (tag === 'RegExp') return String(value);
  if (tag === 'Error') return nested(value.message);
  if (tag === 'Map') return [...value].map(([key, inner]) => `${nested(key)}=>${nested(inner)}`).join(',');
  if (tag === 'Set') return [...value].map(nested).join(',');
  if (['String', 'Number', 'Boolean', 'BigInt', 'Symbol'].includes(tag)) return nested(value.valueOf());
  if (ArrayBuffer.isView(value) && typeof value.length === 'number') return nested(Array.from(value));
  if (typeof value.toJSON === 'function') return nested(value.toJSON());
  return ancestors.length > 1 ? '…' : renderProperties(value, ancestors);
}

function renderObject(value, ancestors) {
  if (Array.isArray(value)) {
    const items = Array.from({ length: value.length }, (_, i) => (i in value ? render(value[i], ancestors) : '<hole>'));
    return `[${items.join(',')}]`;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype) return renderProperties(value, ancestors);
  if (prototype === null) return `<null-proto>${renderProperties(value, ancestors)}`;
  let inside;
  try {
    inside = renderInstance(value, ancestors);
  } catch {
    inside = '<throws>';
  }
  return `${constructorName(prototype)}(${inside})`;
}

/** `ancestors` is the path of objects enclosing `value`, outermost first. */
function render(value, ancestors) {
  if (typeof value === 'string') return renderString(value);
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return renderSymbol(value);
  if (typeof value === 'function') return 'fn';
  if (value === null || typeof value !== 'object') return String(value);
  const at = ancestors.indexOf(value);
  if (at >= 0) return `<cycle^${ancestors.length - at}>`;
  if (ancestors.length >= MAX_DEPTH) return '<deep>';
  return renderObject(value, [...ancestors, value]);
}

/** The label for `value`: unique per distinct input within the limits above, and deterministic. */
export function describe(value) {
  const whole = visible(render(value, []));
  return whole.length <= MAX_LABEL ? whole : `${cut(whole, MAX_LABEL - 10)}…#${hashOf(whole)}`;
}
