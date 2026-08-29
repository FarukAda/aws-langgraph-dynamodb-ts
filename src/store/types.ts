import type { IndexConfig, SerializerProtocol } from '@langchain/langgraph-checkpoint';

import type { PayloadDescriptor } from '../shared/codec/codec';
import type { BaseAdapterOptions, CodecOptions } from '../shared/options';
import type { VectorScoreDirection } from './internal/score-direction';
import type { VectorBackend } from './vector-backend';

/** Options for {@link DynamoDBStore}. */
export type DynamoDBStoreOptions = BaseAdapterOptions &
  CodecOptions & {
    /** Optional semantic-search index configuration (embeddings + fields). */
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
     * the higher-is-better contract without the caller wrapping it.
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
}
