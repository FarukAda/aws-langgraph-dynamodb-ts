[**AWS LangGraph DynamoDB TypeScript v0.9.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBStoreOptions

# Type Alias: DynamoDBStoreOptions

> **DynamoDBStoreOptions** = [`BaseAdapterOptions`](../interfaces/BaseAdapterOptions.md) & [`CodecOptions`](../interfaces/CodecOptions.md) & `object`

Defined in: [store/types.ts:9](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/490338644b9a380688af6900c108cd966b84d00e/src/store/types.ts#L9)

Options for [DynamoDBStore](../classes/DynamoDBStore.md).

## Type Declaration

### index?

> `optional` **index?**: `IndexConfig`

Optional semantic-search index configuration (embeddings + fields).

### maxScanItems?

> `optional` **maxScanItems?**: `number`

Cap on items scanned into memory during a plain (non-semantic) search before ResultTruncatedError. Defaults to MAX_TOTAL_ITEMS_IN_MEMORY.

### maxSearchCandidates?

> `optional` **maxSearchCandidates?**: `number`

Max candidates the in-DB ranker will score before erroring (default 1000).

### serde?

> `optional` **serde?**: `SerializerProtocol`

Optional serializer override (defaults to the JSON serializer).

### vectorBackend?

> `optional` **vectorBackend?**: [`VectorBackend`](../interfaces/VectorBackend.md)

Optional external vector index; when set, similarity search delegates to it.

### vectorScoreDirection?

> `optional` **vectorScoreDirection?**: `VectorScoreDirection`

Direction of the score a `vectorBackend` returns. `'relevance'` (the
default) forwards it unchanged; `'distance'` negates and re-sorts, so a
distance-native backend (S3 Vectors, FAISS L2, pgvector `<->`) satisfies
the higher-is-better contract without the caller wrapping it. Any other
value is rejected at construction with a `ValidationError` rather than
silently ranking one direction as the other.
