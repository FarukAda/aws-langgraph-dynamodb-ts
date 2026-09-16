import type {
  IndexConfig,
  SearchOperation,
  SerializerProtocol,
} from '@langchain/langgraph-checkpoint';

import type { PayloadDescriptor } from '../shared/codec/codec';
import type { BaseAdapterOptions, CancelOptions, CodecOptions } from '../shared/options';
import type { VectorScoreDirection } from './internal/score-direction';
import type { VectorBackend } from './vector-backend';

/** Options for {@link DynamoDBStore}. */
export type DynamoDBStoreOptions = BaseAdapterOptions &
  CodecOptions & {
    /**
     * Optional semantic-search index configuration (embeddings + fields).
     *
     * Without a `vectorBackend` the vectors live on the item itself, one per
     * extracted path at roughly 10 bytes per dimension. They are not counted
     * toward `s3.thresholdBytes` — offload decides on the payload alone — so a
     * value near the threshold plus many vectors is the combination to watch
     * against DynamoDB's 400 KB item limit; see that option's note.
     */
    index?: IndexConfig;
    /** Optional serializer override (defaults to the JSON serializer). */
    serde?: SerializerProtocol;
    /** Optional external vector index; when set, similarity search delegates to it. */
    vectorBackend?: VectorBackend;
    /**
     * Max candidates a semantic search may hold in memory to rank, and the
     * furthest a `vectorBackend` page may reach, before erroring (default
     * 1000). It bounds this process's memory, not the corpus — a corpus larger
     * than this belongs behind a `vectorBackend`.
     */
    maxSearchCandidates?: number;
    /**
     * Cap on rows read into memory by one search, namespace listing or
     * reconcile before `ResultTruncatedError`. Reaching it is an error, not a
     * truncation: a partial answer is never returned as a complete one.
     * Defaults to `MAX_TOTAL_ITEMS_IN_MEMORY`.
     */
    maxScanItems?: number;
    /**
     * Direction of the score a `vectorBackend` returns. `'relevance'` (the
     * default) forwards it unchanged; `'distance'` negates and re-sorts, so a
     * distance-native backend (S3 Vectors, FAISS L2, pgvector `<->`) satisfies
     * the higher-is-better contract without the caller wrapping it. Any other
     * value is rejected at construction with a `ValidationError` rather than
     * silently ranking one direction as the other.
     */
    vectorScoreDirection?: VectorScoreDirection;
  };

/**
 * Options {@link DynamoDBStore.search} accepts: the metadata/paging fields of
 * `SearchOperation` it exposes as its own parameter (`namespacePrefix` is a
 * separate positional argument instead), plus cancellation.
 */
export type SearchOptions = Pick<SearchOperation, 'filter' | 'limit' | 'offset' | 'query'> &
  CancelOptions;

/** The DynamoDB item backing a single stored value. */
export interface StoreItemRecord {
  PK: string;
  SK: string;
  /** Row format version; absent on rows written before it existed (see `row-version.ts`). */
  v?: number;
  /** Recency-index keys; absent on rows written before the index existed. */
  gsi1pk?: string;
  gsi1sk?: string;
  namespace: string[];
  key: string;
  value: PayloadDescriptor;
  createdAt: string;
  updatedAt: string;
  /**
   * One vector per extracted path, scored by best match on read. Absent when
   * the value has no indexable text, or when a `vectorBackend` holds the
   * vectors instead.
   */
  embeddings?: number[][];
  /**
   * The single joined vector rows carried before the store embedded each path
   * separately. Never written now; still read, and scored as a one-element
   * list, so rows written by an earlier version rank exactly as they did.
   */
  embedding?: number[];
  ttl?: number;
  /**
   * Revision token, rewritten on every put. Pins the compare-and-swap that
   * keeps two concurrent overwrites from both deleting the same superseded S3
   * object. Optional: rows written before 0.9.0 carry none.
   */
  rev?: string;
}
