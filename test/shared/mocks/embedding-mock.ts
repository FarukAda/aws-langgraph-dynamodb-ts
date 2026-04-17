import { BedrockEmbeddings } from '@langchain/aws';

/**
 * Default dimension for the mock — matches `amazon.titan-embed-text-v1`
 * (1536 per AWS docs), which is what the library's README recommends. Use
 * {@link createMockEmbeddingWithDim} to exercise other models (e.g. Titan v2
 * at 1024, Cohere v3 at 1024).
 */
const DEFAULT_DIM = 1536;

/**
 * FNV-1a 32-bit hash. Deterministic, branch-free, very fast — good enough to
 * scatter substrings of `text` across every dimension of the output vector.
 */
function fnv1a(input: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Build a deterministic embedding vector whose components are a function of
 * the *entire input text*, not just its length. Two different strings of the
 * same length produce meaningfully different vectors — same length + same
 * chars produce identical vectors — so cosine-similarity tests get real signal
 * instead of a constant.
 *
 * Vectors are normalized to unit length so cosine similarity reduces to a
 * plain dot product (numerically stable, matches how real embedding
 * providers typically return results).
 */
export function hashEmbedding(text: string, dim: number = DEFAULT_DIM): number[] {
  const raw = new Array<number>(dim);
  // Per-dimension seed scatters the same text across the vector.
  for (let i = 0; i < dim; i++) {
    // Feed both the index and the text into the hash so dimensions vary.
    const h = fnv1a(`${i}:${text}`);
    // Map the 32-bit hash into [-1, 1).
    raw[i] = (h / 0xffffffff) * 2 - 1;
  }
  // Normalize to unit length.
  let norm = 0;
  for (const v of raw) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return raw;
  for (let i = 0; i < dim; i++) raw[i] = raw[i] / norm;
  return raw;
}

/**
 * Mock BedrockEmbeddings instance with a hash-based vector generator.
 *
 * The dimension defaults to 1536 (Titan Embed Text v1). The vectors satisfy
 * two useful properties for tests:
 *   1. `hashEmbedding(x)` equals `hashEmbedding(x)` — deterministic across runs
 *   2. `hashEmbedding(x)` differs from `hashEmbedding(y)` when x != y — so the
 *      library's cosine-similarity ranking can actually discriminate results
 */
export function createMockEmbedding(dim: number = DEFAULT_DIM): BedrockEmbeddings {
  return {
    embedQuery: jest.fn(async (text: string): Promise<number[]> => hashEmbedding(text, dim)),
    embedDocuments: jest.fn(
      async (texts: string[]): Promise<number[][]> => texts.map((t) => hashEmbedding(t, dim)),
    ),
  } as unknown as BedrockEmbeddings;
}

/**
 * Mock that always returns a specific vector — useful when a test needs to
 * plant an exact embedding in the store and then query against a crafted
 * vector to assert rank order.
 */
export function createMockEmbeddingWithVector(vector: number[]): BedrockEmbeddings {
  return {
    embedQuery: jest.fn(async (): Promise<number[]> => vector),
    embedDocuments: jest.fn(
      async (texts: string[]): Promise<number[][]> => texts.map(() => vector),
    ),
  } as unknown as BedrockEmbeddings;
}
