[**AWS LangGraph DynamoDB TypeScript v0.0.9**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBChatMessageHistoryOptions

# Interface: DynamoDBChatMessageHistoryOptions

Defined in: [history/types/index.ts:12](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/history/types/index.ts#L12)

Configuration options for DynamoDBChatMessageHistory

## Properties

### clientConfig?

> `optional` **clientConfig**: `DynamoDBClientConfig`

Defined in: [history/types/index.ts:18](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/history/types/index.ts#L18)

Optional DynamoDB client configuration

***

### tableName

> **tableName**: `string`

Defined in: [history/types/index.ts:14](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/history/types/index.ts#L14)

Name of the DynamoDB table to use for storage

***

### ttlDays?

> `optional` **ttlDays**: `number`

Defined in: [history/types/index.ts:16](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/history/types/index.ts#L16)

Optional TTL in days for stored items (1-1825 days)
