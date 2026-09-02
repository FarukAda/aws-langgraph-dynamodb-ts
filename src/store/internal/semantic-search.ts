import type { IndexConfig } from '@langchain/langgraph-checkpoint';

import { ValidationError } from '../../shared/errors/errors';
import type { JsonValue } from './filter';
import type { StoreContext } from './setup';
import { getTextAtPath } from './text-path';

/** Texts per `embedDocuments` call; keeps provider request sizes bounded. */
const EMBED_BATCH_SIZE = 100;

/** Cosine similarity of two equal-length vectors; 0 for zero/mismatched vectors. */
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
 * Extract and join the indexable text of a value for the configured fields,
 * byte-for-byte as LangGraph's `InMemoryStore` does (see `text-path.ts`), so
 * the two stores embed identical text for identical documents.
 */
export function extractText(value: Record<string, JsonValue>, fields: string[]): string {
  return fields.flatMap((field) => getTextAtPath(value, field)).join(' ');
}

/**
 * Reject a vector whose length disagrees with the configured `index.dims`. A
 * mismatch means the embeddings model does not match the configuration, so
 * every stored vector would be incomparable with every query; failing here
 * surfaces that at the first put or search instead of ranking silently. The
 * check is skipped when `dims` is not a positive integer, since nothing else
 * in this package reads it.
 */
export function assertVectorDims(index: IndexConfig, vector: number[], what: string): void {
  const dims = index.dims;
  if (!Number.isInteger(dims) || dims <= 0 || vector.length === dims) return;
  throw new ValidationError(
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
 * retrieval — batched and order-preserving. A value with no indexable text
 * yields `undefined`; without an index every value does.
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
 * Embed one value for indexing, or undefined when indexing is off or the text
 * is empty. `fieldsOverride` (from a put's `index` option) takes precedence
 * over the store's configured fields. See {@link embedValues}.
 */
export async function embedValue(
  context: StoreContext,
  value: Record<string, JsonValue>,
  fieldsOverride?: string[],
): Promise<number[] | undefined> {
  return (await embedValues(context, [value], fieldsOverride))[0];
}
