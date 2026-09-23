/**
 * Hides which text of a value is embedded, and how.
 *
 * The text an index field names is extracted exactly as LangGraph's in-memory
 * store extracts it — dotted paths, `[n]` and `[*]`, `{a,b}` groups, pretty
 * JSON for containers — then embedded in bounded batches, and every vector the
 * model returns is held to the configured dimension.
 */

import type { IndexConfig } from '@langchain/langgraph-checkpoint';

import { validationError } from '../../shared/errors/errors';
import type { JsonValue } from './filter';
import type { StoreContext } from './setup';

/** Texts per `embedDocuments` call; keeps provider request sizes bounded. */
const EMBED_BATCH_SIZE = 100;

/**
 * Cosine similarity of two vectors.
 *
 * Accepts: any two vectors. Lengths that disagree, and a vector of all zeros,
 * have no defined angle between them.
 *
 * Returns: the cosine, in [-1, 1]; `0` for the undefined cases, which ranks
 * such a pair as unrelated rather than as opposed. A caller that must
 * distinguish "unrelated" from "incomparable" checks the lengths itself —
 * `rankInMemory` does, so it can report a model mismatch instead of ranking
 * everything at zero.
 *
 * Throws: nothing.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * The indexable texts of a value, one per extracted path, in field order.
 *
 * Extraction is byte-for-byte what LangGraph's `InMemoryStore` does (see
 * {@link getTextAtPath}), and so is keeping them apart: the reference embeds each
 * extracted element separately and scores an item by its best-matching one.
 * Joining them and embedding once averages a long document into a single
 * vector, which ranks a document holding one strongly-matching section
 * materially lower — a retrieval-quality difference, not an edge case.
 *
 * Accepts: `value` — a stored item's value. `fields` — JSON paths; a path that
 * addresses nothing contributes nothing.
 *
 * Returns: one text per extracted path, in field order, with empty ones
 * dropped: an empty string embeds to a vector that means nothing and would rank
 * against every query.
 *
 * Throws: nothing.
 */
export function extractTexts(value: Record<string, JsonValue>, fields: string[]): string[] {
  return fields.flatMap((field) => getTextAtPath(value, field)).filter((text) => text.length > 0);
}

/**
 * The same texts joined into one, which is what a single-vector consumer needs.
 *
 * Accepts: as {@link extractTexts}.
 *
 * Returns: the texts joined by a space, and `''` when there are none — which is
 * how a caller tells "nothing to index" from a text to embed.
 *
 * Throws: nothing.
 *
 * Used only for a configured `vectorBackend`, whose contract is one vector per
 * `(namespace, key)`; the in-DynamoDB path embeds each text separately.
 */
export function extractText(value: Record<string, JsonValue>, fields: string[]): string {
  return extractTexts(value, fields).join(' ');
}

/**
 * Reject a vector whose length disagrees with the configured `index.dims`. A
 * mismatch means the embeddings model does not match the configuration, so
 * every stored vector would be incomparable with every query; failing here
 * surfaces that at the first put or search instead of ranking silently.
 *
 * Accepts: `index.dims` — the check is skipped when it is not a positive
 * integer, since nothing else in this package reads it and a store configured
 * without it must keep working. `vector` — a document or query vector the model
 * just returned. `what` — names which of the two, for the message.
 *
 * Returns: nothing: `vector` is kept under its declared type, and this
 * checks it.
 *
 * Throws: `VALIDATION` naming `index.dims`.
 */
export function assertVectorDims(index: IndexConfig, vector: number[], what: string): void {
  const dims = index.dims;
  if (!Number.isInteger(dims) || dims <= 0 || vector.length === dims) return;
  throw validationError(
    `index.embeddings returned a ${vector.length}-dimensional ${what} vector but index.dims ` +
      `is ${dims}; the embeddings model does not match the configured index`,
    'index.dims',
  );
}

/** A value's extracted text together with its position in the caller's array. */
interface PendingText {
  text: string;
  position: number;
}

/**
 * Embed several values for indexing with `embedDocuments` — the document-side
 * method; providers such as Titan and Cohere embed documents and queries with
 * different task types, so embedding a document with `embedQuery` degrades
 * retrieval.
 *
 * Accepts: `values` — any number, including none. `fieldsOverride` — a put's
 * own `index` fields; absent uses the store's, and a store with no configured
 * fields indexes the whole document (`'$'`), as the reference does.
 *
 * Returns: one entry per value, in input order: its vector, or `undefined` when
 * the value has no indexable text or the store has no index at all.
 *
 * Throws: `VALIDATION` naming `index.dims` when the model's width disagrees
 * with the configuration; whatever the model throws.
 *
 * Guarantees: values with no text are never sent to the model, and the rest go
 * in batches of {@link EMBED_BATCH_SIZE}, so one call cannot turn into one
 * provider request per item or a single unbounded one.
 */
export async function embedValues(
  context: StoreContext,
  values: Record<string, JsonValue>[],
  fieldsOverride?: string[],
): Promise<(number[] | undefined)[]> {
  const index = context.index;
  if (!index) return values.map(() => undefined);
  const fields = fieldsOverride ?? index.fields ?? ['$'];
  const pending: PendingText[] = [];
  values.forEach((value, position) => {
    const text = extractText(value, fields);
    if (text.length > 0) pending.push({ text, position });
  });
  const vectors: (number[] | undefined)[] = values.map(() => undefined);
  for (let start = 0; start < pending.length; start += EMBED_BATCH_SIZE) {
    const batch = pending.slice(start, start + EMBED_BATCH_SIZE);
    const embedded = await index.embeddings.embedDocuments(batch.map((entry) => entry.text));
    batch.forEach((entry, i) => {
      assertVectorDims(index, embedded[i], 'document');
      vectors[entry.position] = embedded[i];
    });
  }
  return vectors;
}

/**
 * Embed one value for indexing.
 *
 * Accepts: as {@link embedValues}, for one value; `fieldsOverride` (from a
 * put's `index` option) takes precedence over the store's configured fields.
 *
 * Returns: the value's vector, or undefined when indexing is off or it has no
 * indexable text.
 *
 * Throws: as {@link embedValues}.
 */
export async function embedValue(
  context: StoreContext,
  value: Record<string, JsonValue>,
  fieldsOverride?: string[],
): Promise<number[] | undefined> {
  return (await embedValues(context, [value], fieldsOverride))[0];
}

/**
 * One vector per extracted path, for the item's own row — the shape the
 * in-DynamoDB ranker scores by best match, matching the reference store.
 *
 * Accepts: as {@link embedValues}, for one value.
 *
 * Returns: one vector per extracted text, in path order; `undefined` when
 * indexing is off or the value yields no indexable text — which is what clears
 * a stale vector on a re-put, since the row is written without the attribute.
 *
 * Throws: as {@link embedValues}.
 *
 * Guarantees: every text of one value goes in as few `embedDocuments` calls as
 * {@link EMBED_BATCH_SIZE} allows, never one call per path.
 */
export async function embedPassages(
  context: StoreContext,
  value: Record<string, JsonValue>,
  fieldsOverride?: string[],
): Promise<number[][] | undefined> {
  const index = context.index;
  if (!index) return undefined;
  const texts = extractTexts(value, fieldsOverride ?? index.fields ?? ['$']);
  if (texts.length === 0) return undefined;
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
    const embedded = await index.embeddings.embedDocuments(
      texts.slice(start, start + EMBED_BATCH_SIZE),
    );
    for (const vector of embedded) {
      assertVectorDims(index, vector, 'document');
      vectors.push(vector);
    }
  }
  return vectors;
}

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
