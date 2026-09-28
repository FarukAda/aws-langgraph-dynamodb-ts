[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBStoreOptions

# Type Alias: DynamoDBStoreOptions

> **DynamoDBStoreOptions** = `Omit`\<[`BaseAdapterOptions`](../interfaces/BaseAdapterOptions.md), `"indexName"` \| `"indexShards"`\> & [`CodecOptions`](../interfaces/CodecOptions.md) & `object`

Defined in: [store/types.ts:30](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/types.ts#L30)

Options for [DynamoDBStore](../classes/DynamoDBStore.md).

`indexName` and `indexShards` are not store options: no store read uses the
recency index, so a store given either refuses it as an unknown key.

## Type Declaration

### index?

> `optional` **index?**: `IndexConfig`

Optional semantic-search index configuration (embeddings + fields).

Without a `vectorBackend` the vectors live on the item itself, one per
text the configured fields extract — a wildcard path such as
`sections[*].text` extracts one per element — at up to 10 bytes per
dimension. They are not counted toward `s3.thresholdBytes` — offload
decides on the payload alone — and a row they would take past
DynamoDB's 400 KB item limit is refused with `VALIDATION` naming
`index` before anything is written.

### maxIterations?

> `optional` **maxIterations?**: `number`

Cap on DynamoDB pages one search, namespace listing or reconcile reads
before `RESULT_TRUNCATED` (default 1000; a page is at most 1 MB).
`Infinity` reads to the end. It is the cap a rootless search or listing
over a large table meets first when most of what it scans is not store
rows, since those pages hold few rows for `maxScanItems` to count.

### maxScanItems?

> `optional` **maxScanItems?**: `number`

Cap on rows read into memory by one search, namespace listing or
reconcile before `RESULT_TRUNCATED`. Reaching it is an error, not a
truncation: a partial answer is never returned as a complete one.
Defaults to `MAX_TOTAL_ROWS_IN_MEMORY`.

### maxSearchCandidates?

> `optional` **maxSearchCandidates?**: `number`

Max candidates a semantic search may hold in memory to rank, and the
furthest a `vectorBackend` page may reach, before erroring (default
1000). It bounds this process's memory, not the corpus — a corpus larger
than this belongs behind a `vectorBackend`.

### serde?

> `optional` **serde?**: `SerializerProtocol`

Optional serializer override. The default is the exported `JSON_SERDE`,
plain JSON: what it stores is the JSON projection of a value, and the
README's *Table schema* section tabulates where that differs from the
value itself.

### vectorBackend?

> `optional` **vectorBackend?**: [`VectorBackend`](../interfaces/VectorBackend.md)

Optional external vector index; when set, similarity search delegates to it.

### vectorScoreDirection?

> `optional` **vectorScoreDirection?**: [`VectorScoreDirection`](VectorScoreDirection.md)

Direction of the score a `vectorBackend` returns. `'relevance'` (the
default) forwards it unchanged; `'distance'` negates and re-sorts, so a
distance-native backend (S3 Vectors, FAISS L2, pgvector `<->`) satisfies
the higher-is-better contract without the caller wrapping it. Any other
value is rejected at construction with a `VALIDATION` error rather than
silently ranking one direction as the other.
