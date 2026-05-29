import type { IndexConfig, SerializerProtocol } from '@langchain/langgraph-checkpoint';

import type { PayloadDescriptor } from '../shared/codec/codec';
import type { BaseAdapterOptions, CodecOptions } from '../shared/options';
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
