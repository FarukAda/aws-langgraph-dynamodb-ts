/**
 * Hides the rules every caller-supplied primitive must pass.
 *
 * What makes a string an identifier safe inside a key, an integer a page size
 * this package serves, and an array a copy holding only strings is decided
 * once here. Only `parseLimit` returns a branded type of its own —
 * `PageLimit`, which only it can build (record 21); every other rule's
 * `parse*` form returns the plain checked value, and a feature parser brands
 * it into its own type. Feature parsers compose these rules rather than
 * restate them, so tightening one changes every method at once.
 */

import { validationError } from '../errors/errors';

/**
 * Largest `limit` any read accepts, on every method that takes one.
 *
 * Chosen from what a page costs, which is linear in `limit` and amortised
 * nowhere: every row of a page is held decoded and resident until the whole
 * page is handed back, and an offloaded row is an S3 GET and a decompression
 * of its own, `readConcurrency` at a time. A page of N rows is therefore N
 * objects held at once and, in the worst case, N round trips before the caller
 * sees the first of them.
 *
 * Ten thousand is where this package already says a read has stopped being one
 * and become an export: `MAX_TOTAL_ROWS_IN_MEMORY`
 * (`src/shared/dynamodb/paginate.ts`) refuses to collect more than that across
 * a whole paginated query, and `LIST_SCAN_WARN_THRESHOLD`
 * (`src/shared/dynamodb/paginate.ts`) tells an operator about a listing that
 * walks that far. A single page allowed past either would hold more than every
 * other path in the package may. Its own literal at the same value rather than
 * an alias of them, for the reason `LIST_SCAN_WARN_THRESHOLD`
 * (`src/shared/dynamodb/paginate.ts`) records.
 *
 * What it does *not* do is promise a memory figure: rows are the caller's own
 * data, so ten thousand session summaries are a few megabytes while a hundred
 * items at `MAX_INLINE_PAYLOAD_BYTES` (`src/shared/codec/codec.ts`) are forty.
 * It bounds a typo — a `1e12` that would otherwise resolve — not a working set.
 *
 * What a caller loses at the ceiling is one large page, never the rows: every
 * bounded read has a way to continue — `listSessions` a cursor, `search` an
 * `offset`, `getMessages` a `before`, and `saver.list` streams and never
 * accumulates — so an answer larger than this is paid for as pages.
 */
export const MAX_PAGE_LIMIT = 10_000;

declare const pageLimitBrand: unique symbol;

/**
 * A page size checked against the package-wide page rule: an integer from the
 * call site's floor to {@link MAX_PAGE_LIMIT}. {@link parseLimit} is the only
 * way to obtain one, so a reader that asks for a `PageLimit` cannot be handed a
 * size nobody checked, and does not check it again. The brand is phantom: at
 * run time it is the caller's own number.
 */
export type PageLimit = number & { readonly [pageLimitBrand]: true };

/**
 * The value as a string, or a refusal.
 *
 * Accepts: `value` — anything. A JavaScript caller, or a TypeScript caller
 * whose input came from JSON, can pass any type where a string is declared, and
 * every rule after this one reaches a string method.
 *
 * Returns: `value`, typed as the string it was checked to be.
 *
 * Throws: `VALIDATION` naming `field`, for anything that is not a string.
 */
export function parseString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw validationError(`${field} must be a string`, field);
  }
  return value;
}

/**
 * The value as a string holding at least one non-whitespace character.
 *
 * Accepts: `value` — anything; `''` and whitespace-only are refused alongside
 * non-strings.
 *
 * Returns: `value`, typed as a string.
 *
 * Throws: `VALIDATION` naming `field`.
 */
function parseNonBlankString(value: unknown, field: string): string {
  const text = parseString(value, field);
  if (text.trim().length === 0) {
    throw validationError(
      `${field} must be a non-empty string (whitespace-only counts as empty)`,
      field,
    );
  }
  return text;
}

/**
 * Throw `VALIDATION` unless `value` is a string holding at least one
 * non-whitespace character.
 *
 * Accepts: `value` — any type; `''` and whitespace-only are rejected alongside
 * non-strings. `field` — the option or identifier name carried on the error.
 * The rule is {@link parseNonBlankString}'s; this form is for a value the
 * caller keeps under its declared type.
 *
 * Returns: nothing: the value is kept under its declared type, and this
 * checks it.
 *
 * Throws: `VALIDATION` naming `field`.
 */
export function assertNonEmptyString(value: string, field: string): void {
  parseNonBlankString(value, field);
}

/** Throw `VALIDATION` unless `value` encodes to at most `maxBytes` of UTF-8. */
function assertMaxBytes(value: string, field: string, maxBytes: number): void {
  parseString(value, field);
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maxBytes) {
    throw validationError(
      `${field} must be at most ${maxBytes} bytes of UTF-8 (received ${bytes})`,
      field,
    );
  }
}

/**
 * The value as an integer inside `bounds`.
 *
 * Accepts: `value` — anything; a non-number, a fraction, `NaN` and `Infinity`
 * are all refused by the integer rule. `bounds` — omitted or `{}` bounds
 * nothing; `min` and `max` are inclusive.
 *
 * Returns: `value`, typed as a number.
 *
 * Throws: `VALIDATION` naming `field`; the integer rule is reported before
 * either bound.
 */
export function parseInteger(
  value: unknown,
  field: string,
  bounds: { min?: number; max?: number } = {},
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw validationError(`${field} must be an integer`, field);
  }
  if (bounds.min !== undefined && value < bounds.min) {
    throw validationError(`${field} must be >= ${bounds.min}`, field);
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw validationError(`${field} must be <= ${bounds.max}`, field);
  }
  return value;
}

/**
 * Throw `VALIDATION` unless `value` is an integer inside `bounds`.
 *
 * Accepts: `value` — any type; a non-number, a fraction, `NaN` and `Infinity`
 * are all rejected by the integer rule. `bounds` — omitted or `{}` bounds
 * nothing, `min` and `max` are inclusive and may be given together or alone.
 * The rule is {@link parseInteger}'s; this form is for a value the caller
 * keeps under its declared type.
 *
 * Returns: nothing: the value is kept under its declared type, and this
 * checks it.
 *
 * Throws: `VALIDATION` naming `field`; the integer rule is reported before
 * either bound.
 */
export function assertInteger(
  value: number,
  field: string,
  bounds: { min?: number; max?: number } = {},
): void {
  parseInteger(value, field, bounds);
}

/**
 * The value as a page size this package will serve: an integer from `min` to
 * {@link MAX_PAGE_LIMIT}.
 *
 * One rule for every `limit` a public method takes. Without it they would
 * disagree three ways — no minimum on `saver.list`, so `limit: -1` would
 * resolve; `0` refused by the history reads and accepted by the store — and
 * none would have a ceiling, so `limit: 1e12` would resolve on five methods.
 * The same mistake would be answered differently depending on which method a
 * caller happened to reach for.
 *
 * What survives that unification is one message shape, one ceiling and two
 * floors, because zero does not ask for the same thing on every method. A zero
 * *page* is answered: the caller asked a listing for nothing, holds the empty
 * array it returned, and can see that is what it got. A zero *conversation
 * window* is refused: it feeds a model rather than a caller, an empty
 * conversation is indistinguishable from one that never happened, and the
 * answer the model gives is persisted as the transcript. So every call site
 * passes its floor and says why; `1` is passed from exactly one place,
 * `parseMessageWindow` in `src/history/internal/parse.ts`, which is the
 * check behind `history.getMessages` and `history.forSession` alike.
 *
 * Accepts: `value` — any type; a non-number, a fraction, `NaN` and `Infinity`
 * are all rejected by the integer rule. `min` — `0` where an empty result is a
 * request the call site answers without issuing a read, `1` where an empty
 * result would be mistaken for an empty conversation. A negative value is
 * refused at either floor rather than read as zero: it is a page size that was
 * computed, and the computation went wrong.
 *
 * Returns: `value` as a {@link PageLimit}.
 *
 * Throws: `VALIDATION` naming `limit`, quoting the bound broken — the floor
 * or {@link MAX_PAGE_LIMIT} — so the caller is told what the rule is rather
 * than only that it has one.
 */
export function parseLimit(value: unknown, min: 0 | 1): PageLimit {
  return parseInteger(value, 'limit', { min, max: MAX_PAGE_LIMIT }) as PageLimit;
}

/**
 * One element of an array of strings.
 *
 * Accepts: `item` — anything, as the array holds it at `index`, a hole
 * included.
 *
 * Returns: `item`, typed as the string it was checked to be.
 *
 * Throws: `VALIDATION` naming `field`, its message identifying `index`.
 */
function parseStringElement(item: unknown, field: string, index: number): string {
  if (typeof item !== 'string') {
    throw validationError(`${field}[${index}] must be a string`, field);
  }
  return item;
}

/**
 * The value as an array of strings, copied.
 *
 * Accepts: `value` — anything; a non-array is refused, as is an array holding
 * anything but a string. An empty array is valid.
 *
 * Returns: a copy of `value`, so a caller changing its own array afterwards
 * changes nothing this package acts on.
 *
 * Throws: `VALIDATION` naming `field`, its message identifying the offending
 * index. Walked by position rather than `Array.prototype.some`, which skips a
 * hole in a sparse array instead of visiting it, and copied by position rather
 * than `Array.prototype.slice`, which carries a hole forward instead of
 * filling it: unchecked, a hole passed as a string and reached a caller who
 * declared `string[]`.
 */
export function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw validationError(`${field} must be an array of strings`, field);
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    result.push(parseStringElement(value[index], field, index));
  }
  return result;
}

/**
 * Throw `VALIDATION` unless `value` is an array of strings.
 *
 * Accepts: `value` — declared `readonly string[]` for a caller whose types
 * hold; a non-array is rejected, as is an array holding anything but a
 * string. An empty array is valid. The rule is {@link parseStringArray}'s;
 * this form is for a value the caller keeps under its declared type.
 *
 * Returns: nothing: the value is kept under its declared type, and this
 * checks it.
 *
 * Throws: `VALIDATION` naming `field`.
 */
export function assertStringArray(value: readonly string[], field: string): void {
  parseStringArray(value, field);
}

/** True when `value` holds a C0 control character, DEL, or a C1 control character. */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Throw `VALIDATION` unless `value` is free of control characters.
 *
 * Accepts: `value` — any type, non-strings rejected first by
 * {@link parseString}. Rejected code points are C0 (`U+0000`–`U+001F`), DEL
 * (`U+007F`) and C1 (`U+0080`–`U+009F`). The rule is this function's own:
 * {@link parseKeySegment} applies it to every key segment and identifier by
 * calling this one, and this form serves a value the caller keeps under its
 * declared type.
 *
 * Returns: nothing: the value is kept under its declared type, and this
 * checks it.
 *
 * Throws: `VALIDATION` naming `field`.
 *
 * Guarantees: an accepted value cannot terminate a log line or open a terminal
 * escape sequence — neither `ESC` (`U+001B`) nor the single-byte `CSI`
 * (`U+009B`) survives this rule. Identifiers are written into log lines by this
 * package, and unneutralised output is CWE-117
 * (https://cwe.mitre.org/data/definitions/117.html).
 */
export function assertNoControlChars(value: string, field: string): void {
  parseString(value, field);
  if (hasControlChar(value)) {
    throw validationError(`${field} must not contain control characters`, field);
  }
}

/**
 * Throw `VALIDATION` unless every surrogate in `value` is part of a
 * pair.
 *
 * Accepts: `value` — any type, non-strings rejected first by
 * {@link parseString}. The rule is this function's own:
 * {@link parseKeySegment} applies it to every key segment and identifier by
 * calling this one, and this form serves a value the caller keeps under its
 * declared type.
 *
 * Returns: nothing: the value is kept under its declared type, and this
 * checks it.
 *
 * Throws: `VALIDATION` naming `field`.
 *
 * Guarantees: the mapping from an accepted value to its UTF-8 encoding is
 * injective. `Buffer.from(value, 'utf8')` replaces a lone surrogate with
 * U+FFFD, so two values differing only there would encode identically and,
 * where that encoding is a storage key, address one object.
 */
export function assertWellFormed(value: string, field: string): void {
  parseString(value, field);
  if (!value.isWellFormed()) {
    throw validationError(
      `${field} must be well-formed UTF-16 (it contains an unpaired surrogate, which does not ` +
        'survive encoding to UTF-8)',
      field,
    );
  }
}

/** Throw `VALIDATION` if `value` contains `separator`. */
function assertNoSeparator(value: string, separator: string, field: string): void {
  parseString(value, field);
  if (value.includes(separator)) {
    throw validationError(`${field} must not contain the reserved "${separator}" separator`, field);
  }
}

/**
 * One segment of a key, which may be empty: every rule of
 * {@link parseIdentifier} except non-blank. The checkpoint namespace is the one
 * such value — `''` *is* the root namespace — and it is still a segment of both
 * the sort key and the offloaded object's key, so a lone surrogate or a control
 * character in it is as damaging as in any other.
 *
 * Accepts: `value` — anything. `separator`, `field`, `maxBytes` — as
 * {@link parseIdentifier}.
 *
 * Returns: `value`, typed as a string.
 *
 * Throws: `VALIDATION` naming `field`, in this order: string, at most
 * `maxBytes` of UTF-8, free of `separator`, free of control characters,
 * well-formed UTF-16.
 */
export function parseKeySegment(
  value: unknown,
  separator: string,
  field: string,
  maxBytes: number,
): string {
  const text = parseString(value, field);
  assertMaxBytes(text, field, maxBytes);
  assertNoSeparator(text, separator, field);
  assertNoControlChars(text, field);
  assertWellFormed(text, field);
  return text;
}

/**
 * The value as a caller-supplied identifier that reaches a DynamoDB key or an
 * S3 object key, checked.
 *
 * Accepts: `value` — any type. `separator`, `field`, `maxBytes` — as the rules
 * below.
 *
 * Returns: `value`, typed as a string. The caller's parser brands it.
 *
 * Throws: `VALIDATION` naming `field`. The rules apply in this order, and
 * the order is part of the contract because a caller branches on which one
 * failed: string, non-blank, at most `maxBytes` of UTF-8, free of `separator`,
 * free of control characters, well-formed UTF-16.
 *
 * Guarantees: every guarantee of {@link assertNoControlChars} and
 * {@link assertWellFormed} holds for an accepted value, and it composes into a
 * key segment without escaping.
 *
 * Not guaranteed, and deliberately so: an accepted identifier is **not**
 * normalised, and Unicode format characters (`Cf` — `U+200B` ZERO WIDTH SPACE,
 * `U+200C`/`U+200D` the zero-width non-joiner and joiner, `U+FEFF`, `U+202E`
 * RIGHT-TO-LEFT OVERRIDE) and the separators `U+2028`/`U+2029` are all
 * accepted. Two facts make that safe, and one makes it necessary.
 *
 * It is safe because none of them can produce a collision. DynamoDB orders and
 * compares strings by their UTF-8 bytes, and {@link assertWellFormed} has
 * already made the mapping from an accepted identifier to those bytes
 * injective — so two identifiers differing anywhere address two different
 * rows. An identifier that reaches an S3 key is base64url-encoded on the way
 * (`encodeKeyPart`), so none of these characters appears in a key at all. What
 * one actually costs is a log line, a terminal or a console that renders two
 * distinct identifiers alike: confusion for a reader, not a row either of them
 * can reach. Terminal escapes and line breaks, which *are* an injection rather
 * than a rendering, are refused by {@link assertNoControlChars}.
 *
 * It is necessary because refusing `Cf` would refuse ordinary text rather than
 * hostile text. `U+200C` and `U+200D` carry meaning in Persian, Hindi and the
 * Indic scripts — the Persian for "goes" is spelled with a `U+200C` — and
 * `U+200D` is what joins the code points of every multi-person emoji. A rule
 * against `Cf` would reject a `thread_id` or a store `key` taken from ordinary
 * user text, in a package whose identifiers are the caller's own.
 *
 * Normalising would be worse than breaking: `NFC` folds `e` + `U+0301` onto
 * `U+00E9`, so a row written under one form would afterwards be addressed
 * under the other and the caller's data would stop being found. That is silent
 * loss on upgrade, bought with a rendering nicety. A caller who wants either
 * rule can apply it to its own identifiers before passing them.
 */
export function parseIdentifier(
  value: unknown,
  separator: string,
  field: string,
  maxBytes: number,
): string {
  return parseKeySegment(parseNonBlankString(value, field), separator, field, maxBytes);
}
