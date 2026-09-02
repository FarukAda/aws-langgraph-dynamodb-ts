import type { IndexConfig, SerializerProtocol } from '@langchain/langgraph-checkpoint';

import type { PayloadDescriptor } from '../shared/codec/codec';
import type { BaseAdapterOptions, CodecOptions } from '../shared/options';
import type { VectorScoreDirection } from './internal/score-direction';
import type { VectorBackend } from './vector-backend';

/** Options for {@link DynamoDBStore}. */
export type DynamoDBStoreOptions = BaseAdapterOptions &
  CodecOptions & {
    /**
     * Optional semantic-search index configuration (embeddings + fields). The
     * embedding is stored inline on the item (about 10 bytes per dimension) and
     * is not counted toward `s3.thresholdBytes`; see that option's note on the
     * 400 KB item limit.
     */
    index?: IndexConfig;
    /** Optional serializer override (defaults to the JSON serializer). */
    serde?: SerializerProtocol;
    /** Optional external vector index; when set, similarity search delegates to it. */
    vectorBackend?: VectorBackend;
    /** Max candidates the in-DB ranker will score before erroring (default 1000). */
    maxSearchCandidates?: number;
    /** Cap on items scanned into memory during a plain (non-semantic) search before ResultTruncatedError. Defaults to MAX_TOTAL_ITEMS_IN_MEMORY. */
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

/** The DynamoDB item backing a single stored value. */
export interface StoreItemRecord {
  PK: string;
  SK: string;
  namespace: string[];
  key: string;
  value: PayloadDescriptor;
  createdAt: string;
  updatedAt: string;
  embedding?: number[];
  ttl?: number;
  /**
   * Revision token, rewritten on every put. Pins the compare-and-swap that
   * keeps two concurrent overwrites from both deleting the same superseded S3
   * object. Optional: rows written before 0.9.0 carry none.
   */
  rev?: string;
}
