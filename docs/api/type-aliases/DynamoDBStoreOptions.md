[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBStoreOptions

# Type Alias: DynamoDBStoreOptions

> **DynamoDBStoreOptions** = [`BaseAdapterOptions`](../interfaces/BaseAdapterOptions.md) & [`CodecOptions`](../interfaces/CodecOptions.md) & `object`

Defined in: [store/types.ts:13](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/types.ts#L13)

Options for [DynamoDBStore](../classes/DynamoDBStore.md).

## Type Declaration

### index?

> `optional` **index?**: `IndexConfig`

Optional semantic-search index configuration (embeddings + fields).

Without a `vectorBackend` the vectors live on the item itself, one per
extracted path at roughly 10 bytes per dimension. They are not counted
toward `s3.thresholdBytes` — offload decides on the payload alone — so a
value near the threshold plus many vectors is the combination to watch
against DynamoDB's 400 KB item limit; see that option's note.

### maxScanItems?

> `optional` **maxScanItems?**: `number`

Cap on rows read into memory by one search, namespace listing or
reconcile before `ResultTruncatedError`. Reaching it is an error, not a
truncation: a partial answer is never returned as a complete one.
Defaults to `MAX_TOTAL_ITEMS_IN_MEMORY`.

### maxSearchCandidates?

> `optional` **maxSearchCandidates?**: `number`

Max candidates a semantic search may hold in memory to rank, and the
furthest a `vectorBackend` page may reach, before erroring (default
1000). It bounds this process's memory, not the corpus — a corpus larger
than this belongs behind a `vectorBackend`.

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
