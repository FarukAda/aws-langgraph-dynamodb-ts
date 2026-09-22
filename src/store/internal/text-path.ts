import type { JsonValue } from './filter';

/** A JSON object (not an array), the shape `in` lookups and `{…}` groups walk. */
type JsonObject = { [key: string]: JsonValue };

/**
 * Pretty JSON, exactly as `InMemoryStore` embeds non-scalar values, as a list so
 * that a value with no JSON text contributes nothing.
 *
 * `JSON.stringify` answers "no text" in two ways: it *returns* undefined for a
 * value JSON cannot represent (`undefined`, a function, a symbol) and it
 * *throws* for one it refuses (a circular structure, a `BigInt`). Both mean the
 * same thing here — there is no text to index — and neither may escape: the
 * first used to put a literal `undefined` into a `string[]` and crash the
 * caller's `text.length` filter, and the second used to surface a raw
 * `TypeError` from inside the embedding step. A value JSON refuses outright is
 * still refused, by the codec, at the write that follows, which names the
 * offending field.
 */
function prettyText(value: JsonValue): string[] {
  let text: string | undefined;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    return [];
  }
  return text === undefined ? [] : [text];
}

function isScalar(value: JsonValue): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** Text for a leaf: scalars stringify, containers pretty-print, null yields nothing. */
function leafText(value: JsonValue): string[] {
  if (isScalar(value)) return [String(value)];
  if (value === null) return [];
  return prettyText(value);
}

/** Index just past the closer matching an opener at `start - 1`, honouring nesting. */
function scanGroup(path: string, start: number, open: string, close: string): number {
  let depth = 1;
  let i = start;
  while (i < path.length && depth > 0) {
    if (path[i] === open) depth += 1;
    else if (path[i] === close) depth -= 1;
    i += 1;
  }
  return i;
}

/**
 * Split a JSON path into tokens the way LangGraph's `InMemoryStore` does: dots
 * separate plain segments, while a `[…]` index and a `{…}` field group each
 * become a token of their own (`tags[0]` → `['tags', '[0]']`).
 *
 * Accepts: any path string. An empty path, and a path of nothing but
 * separators, tokenize to nothing. An **unterminated** `[` or `{` runs to the
 * end of the path and becomes a token that no longer closes — `'tags[0'` →
 * `['tags', '[0']` — so it is resolved as a plain member name and matches
 * nothing unless the value at `tags` holds a field literally called `[0`. That is the reference
 * tokenizer's own answer (`@langchain/langgraph-checkpoint@1.1.5`
 * `dist/store/utils.js:23-30`), and matching it matters more than refusing the
 * path: `index.fields` is validated where it is configured, and text extraction
 * must stay byte-for-byte comparable with the reference store.
 *
 * Returns: the tokens, in path order.
 *
 * Throws: nothing.
 */
export function tokenizePath(path: string): string[] {
  const tokens: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.length > 0) tokens.push(current);
    current = '';
  };
  let i = 0;
  while (i < path.length) {
    const char = path[i];
    if (char === '[' || char === '{') {
      flush();
      const end = scanGroup(path, i + 1, char, char === '[' ? ']' : '}');
      tokens.push(path.slice(i, end));
      i = end;
      continue;
    }
    if (char === '.') flush();
    else current += char;
    i += 1;
  }
  flush();
  return tokens;
}

/** Walk one `{…}`-group field by plain `in` lookups, as the reference does. */
function groupFieldText(value: JsonObject | JsonValue[], field: string): string[] {
  let current: JsonValue | undefined = value;
  for (const token of tokenizePath(field)) {
    if (current !== null && typeof current === 'object' && token in current) {
      current = (current as JsonObject)[token];
    } else {
      return [];
    }
  }
  return isScalar(current) ? [String(current)] : prettyText(current);
}

/** Resolve a `[n]`, `[-n]` or `[*]` token against an array; anything else yields nothing. */
function indexText(value: JsonValue, token: string, tokens: string[], pos: number): string[] {
  if (!Array.isArray(value)) return [];
  const index = token.slice(1, -1);
  if (index === '*') return value.flatMap((item) => extract(item, tokens, pos + 1));
  let idx = Number.parseInt(index, 10);
  if (Number.isNaN(idx)) return [];
  if (idx < 0) idx = value.length + idx;
  return idx >= 0 && idx < value.length ? extract(value[idx], tokens, pos + 1) : [];
}

/** Resolve a `{a,b.c}` token: each listed field, walked from the current value. */
function groupText(value: JsonValue, token: string): string[] {
  if (typeof value !== 'object' || value === null) return [];
  const results: string[] = [];
  for (const field of token.slice(1, -1).split(',')) {
    const trimmed = field.trim();
    if (tokenizePath(trimmed).length > 0) results.push(...groupFieldText(value, trimmed));
  }
  return results;
}

/** Resolve a bare `*` token: every array item or every object value. */
function wildcardText(value: JsonValue, tokens: string[], pos: number): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => extract(item, tokens, pos + 1));
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap((item) => extract(item, tokens, pos + 1));
  }
  return [];
}

/** Resolve a plain member token by an `in` lookup, exactly as the reference does. */
function memberText(value: JsonValue, token: string, tokens: string[], pos: number): string[] {
  if (typeof value !== 'object' || value === null || !(token in value)) return [];
  return extract((value as JsonObject)[token], tokens, pos + 1);
}

function extract(value: JsonValue, tokens: string[], pos: number): string[] {
  if (pos >= tokens.length) return leafText(value);
  const token = tokens[pos];
  if (token.startsWith('[') && token.endsWith(']')) return indexText(value, token, tokens, pos);
  const results: string[] = pos === 0 && token === '$' ? prettyText(value) : [];
  if (token.startsWith('{') && token.endsWith('}')) results.push(...groupText(value, token));
  else if (token === '*') results.push(...wildcardText(value, tokens, pos));
  else results.push(...memberText(value, token, tokens, pos));
  return results;
}

/**
 * Extract the indexable text of `value` at `path`, byte-for-byte as LangGraph's
 * `InMemoryStore` does (`store/utils`), so an embedding computed here matches
 * one computed by the reference store for the same document. Supports plain
 * paths, `[n]`/`[-n]`/`[*]` indexing, a bare `*` wildcard, `{a,b.c}` field
 * groups and `$` for the whole document. The package root's `getTextAtPath` is
 * a string-only variant that returns nothing for numbers, booleans, objects
 * and arrays and throws on a `null` intermediate; it must not be used here.
 *
 * Accepts: `value` — any stored value, including a scalar and `null`. `path` —
 * empty or `$` asks for the whole document; anything else is tokenized. A path
 * that addresses nothing present, a `[n]` against a non-array, a `{…}` group
 * against a non-object: each yields no text rather than an error, because one
 * unindexable field of one item must not fail a put or a search.
 *
 * Returns: the extracted texts, in path order — one per match, kept apart so
 * each is embedded on its own (see `extractTexts`). Empty when the path
 * addresses nothing, and empty for a leaf JSON cannot represent.
 *
 * Throws: nothing.
 */
export function getTextAtPath(value: JsonValue, path: string): string[] {
  if (path === '' || path === '$') return prettyText(value);
  return extract(value, tokenizePath(path), 0);
}
