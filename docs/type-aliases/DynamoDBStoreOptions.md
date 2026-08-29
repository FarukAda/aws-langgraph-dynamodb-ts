[**AWS LangGraph DynamoDB TypeScript v0.8.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBStoreOptions

# Type Alias: DynamoDBStoreOptions

> **DynamoDBStoreOptions** = [`BaseAdapterOptions`](../interfaces/BaseAdapterOptions.md) & [`CodecOptions`](../interfaces/CodecOptions.md) & `object`

Defined in: [store/types.ts:8](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/5a137c4668c089acbdd8dcb66b61b636923c4718/src/store/types.ts#L8)

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
