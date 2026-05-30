/** A vector-similarity match returned by an external {@link VectorBackend}. */
export interface VectorMatch {
  namespace: string[];
  key: string;
  score: number;
}

/** A stored vector's location, returned by {@link VectorBackend.listKeys}. */
export interface VectorRef {
  namespace: string[];
  key: string;
}

/**
 * Pluggable vector index. When provided to the store, embeddings live here and
 * similarity search is delegated to it; DynamoDB still holds the canonical item.
 */
export interface VectorBackend {
  upsert(namespace: string[], key: string, vector: number[]): Promise<void>;
  query(namespacePrefix: string[], queryVector: number[], topK: number): Promise<VectorMatch[]>;
  delete(namespace: string[], key: string): Promise<void>;
  /**
   * Optionally enumerate every stored vector under `namespacePrefix`. Enables
   * `reconcileVectorIndex` to prune vectors orphaned by a lost delete. Omit it
   * when the backend cannot enumerate — reconciliation then re-pushes only.
   */
  listKeys?(namespacePrefix: string[]): Promise<VectorRef[]>;
}
