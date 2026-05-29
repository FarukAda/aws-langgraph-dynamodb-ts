import { getTextAtPath } from '@langchain/langgraph-checkpoint';

import type { JsonValue } from './filter';
import type { StoreContext } from './setup';

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

/** Extract and join the indexable text of a value for the configured fields. */
export function extractText(value: Record<string, JsonValue>, fields: string[]): string {
  const parts: string[] = [];
  for (const field of fields) {
    if (field === '$') parts.push(JSON.stringify(value));
    else parts.push(...getTextAtPath(value, field));
  }
  return parts.join(' ');
}

/** Embed a value for indexing, or undefined when indexing is off or text empty. */
export async function embedValue(
  context: StoreContext,
  value: Record<string, JsonValue>,
): Promise<number[] | undefined> {
  if (!context.index) return undefined;
  const text = extractText(value, context.index.fields ?? ['$']);
  if (text.length === 0) return undefined;
  return context.index.embeddings.embedQuery(text);
}
