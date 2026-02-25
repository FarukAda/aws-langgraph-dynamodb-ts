[**AWS LangGraph DynamoDB TypeScript v0.1.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBStoreOptions

# Interface: DynamoDBStoreOptions

Defined in: [store/types/index.ts:19](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/store/types/index.ts#L19)

Configuration options for DynamoDBStore

## Properties

### client?

> `optional` **client**: `DynamoDBDocument`

Defined in: [store/types/index.ts:29](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/store/types/index.ts#L29)

Optional pre-built DynamoDBDocument client (takes precedence over clientConfig)

***

### clientConfig?

> `optional` **clientConfig**: `DynamoDBClientConfig`

Defined in: [store/types/index.ts:25](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/store/types/index.ts#L25)

Optional DynamoDB client configuration

***

### embedding?

> `optional` **embedding**: `EmbeddingsInterface`\<`number`[]\>

Defined in: [store/types/index.ts:23](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/store/types/index.ts#L23)

Optional embeddings for semantic search (any LangChain Embeddings provider)

***

### memoryTableName

> **memoryTableName**: `string`

Defined in: [store/types/index.ts:21](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/store/types/index.ts#L21)

Name of the DynamoDB table to use for storage

***

### ttlDays?

> `optional` **ttlDays**: `number`

Defined in: [store/types/index.ts:27](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/store/types/index.ts#L27)

Optional TTL in days for stored items (1-1825 days)
