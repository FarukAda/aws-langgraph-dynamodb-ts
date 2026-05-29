import type { IndexConfig } from '@langchain/langgraph-checkpoint';
import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import type { PayloadDescriptor } from '../shared/codec/codec';
import type { BaseAdapterOptions, CodecOptions } from '../shared/options';

/** Options for {@link DynamoDBStore}. */
export type DynamoDBStoreOptions = BaseAdapterOptions &
  CodecOptions & {
    /** Optional semantic-search index configuration (embeddings + fields). */
    index?: IndexConfig;
    /** Optional serializer override (defaults to the JSON serializer). */
    serde?: SerializerProtocol;
  };

/** The DynamoDB item backing a single stored value. */
export interface StoreItemRecord {
  PK: string;
  SK: string;
  namespace: string[];
  value: PayloadDescriptor;
  createdAt: string;
  updatedAt: string;
  embedding?: number[];
  ttl?: number;
}
