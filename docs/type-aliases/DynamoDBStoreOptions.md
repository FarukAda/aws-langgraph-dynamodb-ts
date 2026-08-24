[**AWS LangGraph DynamoDB TypeScript v0.3.1**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBStoreOptions

# Type Alias: DynamoDBStoreOptions

> **DynamoDBStoreOptions** = [`BaseAdapterOptions`](../interfaces/BaseAdapterOptions.md) & [`CodecOptions`](../interfaces/CodecOptions.md) & `object`

Defined in: [store/types.ts:8](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/store/types.ts#L8)

Options for [DynamoDBStore](../classes/DynamoDBStore.md).

## Type Declaration

### index?

> `optional` **index?**: `IndexConfig`

Optional semantic-search index configuration (embeddings + fields).

### maxSearchCandidates?

> `optional` **maxSearchCandidates?**: `number`

Max candidates the in-DB ranker will score before erroring (default 1000).

### serde?

> `optional` **serde?**: `SerializerProtocol`

Optional serializer override (defaults to the JSON serializer).

### vectorBackend?

> `optional` **vectorBackend?**: [`VectorBackend`](../interfaces/VectorBackend.md)

Optional external vector index; when set, similarity search delegates to it.
