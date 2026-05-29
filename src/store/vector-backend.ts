/** A vector-similarity match returned by an external {@link VectorBackend}. */
export interface VectorMatch {
  namespace: string[];
  key: string;
  score: number;
}

/**
 * Pluggable vector index. When provided to the store, embeddings live here and
 * similarity search is delegated to it; DynamoDB still holds the canonical item.
 */
export interface VectorBackend {
  upsert(namespace: string[], key: string, vector: number[]): Promise<void>;
  query(namespacePrefix: string[], queryVector: number[], topK: number): Promise<VectorMatch[]>;
  delete(namespace: string[], key: string): Promise<void>;
}
