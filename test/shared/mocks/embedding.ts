/**
 * Deterministic EmbeddingsInterface mock plus edge-case factories used by store
 * put / search tests (REQ-35 / gap N / AC-31).
 *
 * No Math.random — embeddings are derived deterministically from the input
 * string so the same document always maps to the same vector.
 */
import type { EmbeddingsInterface } from '@langchain/core/embeddings';

export interface EmbeddingMockOptions {
  /** Dimension of returned vectors (default 4). */
  dimensions?: number;
}

/** Deterministic vector from a string: stable, no randomness. */
function deterministicVector(text: string, dimensions: number): number[] {
  const vec: number[] = [];
  for (let i = 0; i < dimensions; i += 1) {
    let h = 0;
    for (let c = 0; c < text.length; c += 1) {
      h = (h * 31 + text.charCodeAt(c) + i) % 1000;
    }
    vec.push(h / 1000);
  }
  return vec;
}

export interface RecordingEmbeddings extends EmbeddingsInterface {
  calls: string[][];
  callCount: number;
}

/** Standard deterministic embedding mock. */
export function makeEmbeddingMock(opts: EmbeddingMockOptions = {}): EmbeddingsInterface {
  const dimensions = opts.dimensions ?? 4;
  return {
    embedDocuments: async (docs: string[]) => docs.map((d) => deterministicVector(d, dimensions)),
    embedQuery: async (text: string) => deterministicVector(text, dimensions),
  };
}

/** embedDocuments returns null (documented N edge case). */
export function embeddingReturnsNull(): EmbeddingsInterface {
  return {
    embedDocuments: async () => null as unknown as number[][],
    embedQuery: async () => null as unknown as number[],
  };
}

/** embedDocuments returns fewer vectors than documents. */
export function embeddingReturnsShort(): EmbeddingsInterface {
  return {
    embedDocuments: async (docs: string[]) =>
      docs.slice(0, Math.max(0, docs.length - 1)).map((d) => deterministicVector(d, 4)),
    embedQuery: async (text: string) => deterministicVector(text, 4),
  };
}

/** embedDocuments returns vectors containing NaN entries. */
export function embeddingReturnsNaN(): EmbeddingsInterface {
  return {
    embedDocuments: async (docs: string[]) => docs.map(() => [NaN, 0.1, 0.2, 0.3]),
    embedQuery: async () => [NaN, 0.1, 0.2, 0.3],
  };
}

/** embedDocuments returns vectors of mismatched dimensions within a batch. */
export function embeddingDimensionMismatch(): EmbeddingsInterface {
  return {
    embedDocuments: async (docs: string[]) =>
      docs.map((d, i) => deterministicVector(d, i === 0 ? 4 : 3)),
    embedQuery: async (text: string) => deterministicVector(text, 4),
  };
}

/** embedDocuments throws. */
export function embeddingThrows(
  err: Error = new Error('embedding service unavailable'),
): EmbeddingsInterface {
  return {
    embedDocuments: async () => {
      throw err;
    },
    embedQuery: async () => {
      throw err;
    },
  };
}

/** Records call arguments and count (for "no call on empty input" assertions). */
export function recordingEmbeddingMock(opts: EmbeddingMockOptions = {}): RecordingEmbeddings {
  const dimensions = opts.dimensions ?? 4;
  const calls: string[][] = [];
  const mock = {
    calls,
    get callCount() {
      return calls.length;
    },
    embedDocuments: async (docs: string[]) => {
      calls.push(docs);
      return docs.map((d) => deterministicVector(d, dimensions));
    },
    embedQuery: async (text: string) => {
      calls.push([text]);
      return deterministicVector(text, dimensions);
    },
  };
  return mock as unknown as RecordingEmbeddings;
}
