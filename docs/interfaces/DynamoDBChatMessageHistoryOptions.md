[**AWS LangGraph DynamoDB TypeScript v0.0.7**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBChatMessageHistoryOptions

# Interface: DynamoDBChatMessageHistoryOptions

Defined in: history/types/index.ts:12

Configuration options for DynamoDBChatMessageHistory

## Properties

### clientConfig?

> `optional` **clientConfig**: `DynamoDBClientConfig`

Defined in: history/types/index.ts:18

Optional DynamoDB client configuration

***

### tableName

> **tableName**: `string`

Defined in: history/types/index.ts:14

Name of the DynamoDB table to use for storage

***

### ttlDays?

> `optional` **ttlDays**: `number`

Defined in: history/types/index.ts:16

Optional TTL in days for stored items (1-1825 days)
