import type { IndexConfig } from '@langchain/langgraph-checkpoint';

import { validationError } from '../../shared/errors/errors';
import type { JsonValue } from './filter';
import type { StoreContext } from './setup';
import { getTextAtPath } from './text-path';

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
 * `text-path.ts`), and so is keeping them apart: the reference embeds each
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
