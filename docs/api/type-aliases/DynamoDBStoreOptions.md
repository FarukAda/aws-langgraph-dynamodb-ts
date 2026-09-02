[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBStoreOptions

# Type Alias: DynamoDBStoreOptions

> **DynamoDBStoreOptions** = [`BaseAdapterOptions`](../interfaces/BaseAdapterOptions.md) & [`CodecOptions`](../interfaces/CodecOptions.md) & `object`

Defined in: [store/types.ts:9](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/store/types.ts#L9)

Options for [DynamoDBStore](../classes/DynamoDBStore.md).

## Type Declaration

### index?

> `optional` **index?**: `IndexConfig`

Optional semantic-search index configuration (embeddings + fields). The
embedding is stored inline on the item (about 10 bytes per dimension) and
is not counted toward `s3.thresholdBytes`; see that option's note on the
400 KB item limit.

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

> `optional` **vectorScoreDirection?**: [`VectorScoreDirection`](VectorScoreDirection.md)

Direction of the score a `vectorBackend` returns. `'relevance'` (the
default) forwards it unchanged; `'distance'` negates and re-sorts, so a
distance-native backend (S3 Vectors, FAISS L2, pgvector `<->`) satisfies
the higher-is-better contract without the caller wrapping it. Any other
value is rejected at construction with a `ValidationError` rather than
silently ranking one direction as the other.
