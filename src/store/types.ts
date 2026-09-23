import type {
  IndexConfig,
  SearchOperation,
  SerializerProtocol,
} from '@langchain/langgraph-checkpoint';

import type { BaseAdapterOptions, CancelOptions, CodecOptions } from '../shared/options';
import type { VectorBackend, VectorScoreDirection } from './vector-backend';

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
    /**
     * Optional serializer override. The default is the exported `JSON_SERDE`,
     * plain JSON: what it stores is the JSON projection of a value, and the
     * README's *Table schema* section tabulates where that differs from the
     * value itself.
     */
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
     * reconcile before `RESULT_TRUNCATED`. Reaching it is an error, not a
     * truncation: a partial answer is never returned as a complete one.
     * Defaults to `MAX_TOTAL_ITEMS_IN_MEMORY`.
     */
    maxScanItems?: number;
    /**
     * Direction of the score a `vectorBackend` returns. `'relevance'` (the
     * default) forwards it unchanged; `'distance'` negates and re-sorts, so a
     * distance-native backend (S3 Vectors, FAISS L2, pgvector `<->`) satisfies
     * the higher-is-better contract without the caller wrapping it. Any other
     * value is rejected at construction with a `VALIDATION` error rather than
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

/**
 * Options {@link DynamoDBStore.listNamespaces} accepts: the object
 * `BaseStore.listNamespaces` declares inline, with the same five optional
 * fields, named so a caller can type the options it builds. A test pins it
 * equal to upstream's parameter type.
 */
export interface ListNamespacesOptions {
  /** Only namespaces starting with these labels; `'*'` matches any one label. */
  prefix?: string[];
  /** Only namespaces ending with these labels; `'*'` matches any one label. */
  suffix?: string[];
  /**
   * Truncate each namespace to at most this many labels, at least 1; the
   * namespaces that truncation makes equal are listed once.
   */
  maxDepth?: number;
  /**
   * How many namespaces to return, from 0 to `MAX_PAGE_LIMIT` (10,000);
   * default 100. `0` returns an empty array without reading the table.
   */
  limit?: number;
  /** How many namespaces to skip first, a non-negative integer; default 0. */
  offset?: number;
}
