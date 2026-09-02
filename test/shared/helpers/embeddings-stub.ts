/**
 * An `Embeddings` stub for unit tests: every document vector is `vector` and
 * `embedQuery` resolves `queryVector` (defaults to the same vector). Both
 * methods are `jest.fn()` so tests can assert which side of the API a code
 * path used — documents must go through `embedDocuments`, queries through
 * `embedQuery`.
 */
export function stubEmbeddings(vector: number[], queryVector: number[] = vector) {
  return {
    embedQuery: jest.fn().mockResolvedValue(queryVector),
    embedDocuments: jest.fn(async (texts: string[]) => texts.map(() => vector)),
  };
}
