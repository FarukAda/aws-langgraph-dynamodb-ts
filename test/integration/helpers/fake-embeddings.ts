import type { EmbeddingsInterface } from '@langchain/core/embeddings';

const DIMS = 8;

/**
 * Deterministic bag-of-characters embedding: stable, offline, and free of any
 * network call. Texts that share characters land near each other, which is
 * enough to assert semantic ranking order in integration tests.
 */
export class FakeEmbeddings implements EmbeddingsInterface {
  async embedQuery(text: string): Promise<number[]> {
    const vector = new Array(DIMS).fill(0);
    for (const char of text.toLowerCase()) {
      vector[char.charCodeAt(0) % DIMS] += 1;
    }
    return vector;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embedQuery(text)));
  }
}
