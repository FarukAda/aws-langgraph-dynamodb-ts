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

/** Which direction a {@link VectorBackend} reports its score in. */
export type VectorScoreDirection = 'relevance' | 'distance';

/**
 * Pluggable vector index. When provided to the store, embeddings live here and
 * similarity search is delegated to it; DynamoDB still holds the canonical item.
 *
 * This is an interface you implement, so what the store promises and what it
 * requires are both stated per method. Two properties hold throughout: the
 * store writes DynamoDB first and syncs here afterwards, so the backend may lag
 * the canonical item and `reconcileVectorIndex` exists to close that gap; and
 * every result is re-read from DynamoDB before a caller sees it, so a stale
 * entry costs a wasted read, never a wrong answer.
 */
export interface VectorBackend {
  /**
   * Store one item's vector.
   *
   * Receives: a validated `namespace` and `key`, and a vector of the width
   * `index.dims` declares. Called once per indexed put, after the item is
   * committed, and again for every item of a `reconcileVectorIndex`.
   *
   * Must: replace any vector already held for that `(namespace, key)` —
   * upserting the same pair repeatedly is normal and must not accumulate
   * entries.
   *
   * May throw: a rejection is logged and swallowed on the put path (the item
   * still stands) and propagates from a reconcile.
   */
  upsert(namespace: string[], key: string, vector: number[]): Promise<void>;
  /**
   * Return up to `topK` matches under `namespacePrefix`, best first.
   *
   * Receives: the same query vector width as `upsert`, and a `topK` the store
   * raises — up to `maxSearchCandidates` — while its filter leaves the page
   * short, so returning fewer than `topK` is read as "that is all there is".
   *
   * Must: order best-first, and score each match as a relevance, not a
   * distance (see {@link VectorMatch.score}). Matches outside the prefix, and
   * matches whose item has since been deleted, are dropped by the store rather
   * than trusted — over-returning is safe, under-returning silently shortens
   * the page.
   */
  query(namespacePrefix: string[], queryVector: number[], topK: number): Promise<VectorMatch[]>;
  /**
   * Drop one item's vector.
   *
   * Receives: the item's address. Called when the item is deleted, and also
   * after any put that produced no vector — `index: false`, or a value with no
   * indexable text — because the previous vector would otherwise keep matching
   * an item that no longer has that text.
   *
   * Must: succeed for a key that holds no vector. That is the common case on
   * the no-vector put path, and treating it as an error would warn on every
   * such put.
   */
  delete(namespace: string[], key: string): Promise<void>;
  /**
   * Optionally enumerate every stored vector under `namespacePrefix`. Enables
   * `reconcileVectorIndex` to prune vectors orphaned by a lost delete. Omit it
   * when the backend cannot enumerate — reconciliation then re-pushes only.
   *
   * Must: not return keys from outside `namespacePrefix`. Under-reporting only
   * leaves an orphan for a later reconcile; over-reporting offers a vector
   * outside the scope for pruning, and the reconcile is what would delete it.
   */
  listKeys?(namespacePrefix: string[]): Promise<VectorRef[]>;
}

/**
 * Every direction `toRelevanceScores` (store/internal/vector-index.ts)
 * recognises, for validating input.
 */
export const VECTOR_SCORE_DIRECTIONS: readonly VectorScoreDirection[] = ['relevance', 'distance'];
