[**AWS LangGraph DynamoDB TypeScript v0.1.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBChatMessageHistoryOptions

# Interface: DynamoDBChatMessageHistoryOptions

Defined in: [history/types/index.ts:13](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/history/types/index.ts#L13)

Configuration options for DynamoDBChatMessageHistory

## Properties

### client?

> `optional` **client**: `DynamoDBDocument`

Defined in: [history/types/index.ts:21](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/history/types/index.ts#L21)

Optional pre-built DynamoDBDocument client (takes precedence over clientConfig)

***

### clientConfig?

> `optional` **clientConfig**: `DynamoDBClientConfig`

Defined in: [history/types/index.ts:19](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/history/types/index.ts#L19)

Optional DynamoDB client configuration

***

### tableName

> **tableName**: `string`

Defined in: [history/types/index.ts:15](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/history/types/index.ts#L15)

Name of the DynamoDB table to use for storage

***

### ttlDays?

> `optional` **ttlDays**: `number`

Defined in: [history/types/index.ts:17](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/history/types/index.ts#L17)

Optional TTL in days for stored items (1-1825 days)
