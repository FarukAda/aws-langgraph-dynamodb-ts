/** A vector-similarity match returned by an external {@link VectorBackend}. */
export interface VectorMatch {
  namespace: string[];
  key: string;
  /**
   * Relevance, where **higher means a better match** — the same direction as
   * upstream `SearchItem.score`, which this value is forwarded to verbatim.
   *
   * A backend whose native output is a *distance* (S3 Vectors, FAISS L2,
   * pgvector's `<->`) has two options: convert before returning, or declare
   * `vectorScoreDirection: 'distance'` on the store, which negates and
   * re-sorts for you. Forwarding an unconverted distance without declaring it
   * yields results ordered correctly but scored backwards, which silently
   * breaks any caller that thresholds or displays the number; that case is
   * warned about but never reordered.
   */
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
  /**
   * Return up to `topK` matches under `namespacePrefix`, best first. Each
   * match's `score` must be a relevance, not a distance — see
   * {@link VectorMatch.score}.
   */
  query(namespacePrefix: string[], queryVector: number[], topK: number): Promise<VectorMatch[]>;
  delete(namespace: string[], key: string): Promise<void>;
  /**
   * Optionally enumerate every stored vector under `namespacePrefix`. Enables
   * `reconcileVectorIndex` to prune vectors orphaned by a lost delete. Omit it
   * when the backend cannot enumerate — reconciliation then re-pushes only.
   */
  listKeys?(namespacePrefix: string[]): Promise<VectorRef[]>;
}
