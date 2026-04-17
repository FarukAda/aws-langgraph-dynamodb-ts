[**AWS LangGraph DynamoDB TypeScript v0.2.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBStoreOptions

# Interface: DynamoDBStoreOptions

Defined in: [store/types/index.ts:19](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/store/types/index.ts#L19)

Configuration options for DynamoDBStore

## Properties

### client?

> `optional` **client?**: `DynamoDBDocument`

Defined in: [store/types/index.ts:29](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/store/types/index.ts#L29)

Optional pre-built DynamoDBDocument client (takes precedence over clientConfig)

***

### clientConfig?

> `optional` **clientConfig?**: `DynamoDBClientConfig`

Defined in: [store/types/index.ts:25](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/store/types/index.ts#L25)

Optional DynamoDB client configuration

***

### embedding?

> `optional` **embedding?**: `EmbeddingsInterface`\<`number`[]\>

Defined in: [store/types/index.ts:23](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/store/types/index.ts#L23)

Optional embeddings for semantic search (any LangChain Embeddings provider)

***

### fallbackToLexicalOnEmbeddingFailure?

> `optional` **fallbackToLexicalOnEmbeddingFailure?**: `boolean`

Defined in: [store/types/index.ts:42](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/store/types/index.ts#L42)

Controls behavior when a semantic-search embedding call (e.g. `embedding.embedQuery`)
fails — for example because Bedrock is rate-limited or unreachable.

- `false` (default, **fail-closed**): the error propagates to the caller so
  semantic search never silently degrades to unranked results. Recommended
  for production to preserve the caller's trust that "a result ranked by
  similarity" is what was actually returned.
- `true` (fail-open): the error is logged and the raw (unranked) DynamoDB
  result set is returned instead. Only set this if your application has
  explicit, user-visible handling for degraded search quality.

***

### memoryTableName

> **memoryTableName**: `string`

Defined in: [store/types/index.ts:21](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/store/types/index.ts#L21)

Name of the DynamoDB table to use for storage

***

### ttlDays?

> `optional` **ttlDays?**: `number`

Defined in: [store/types/index.ts:27](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/store/types/index.ts#L27)

Optional TTL in days for stored items (1-1825 days)
