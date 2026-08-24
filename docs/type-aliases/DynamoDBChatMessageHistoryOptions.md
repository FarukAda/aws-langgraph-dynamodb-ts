[**AWS LangGraph DynamoDB TypeScript v0.3.1**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBChatMessageHistoryOptions

# Type Alias: DynamoDBChatMessageHistoryOptions

> **DynamoDBChatMessageHistoryOptions** = [`BaseAdapterOptions`](../interfaces/BaseAdapterOptions.md) & [`CodecOptions`](../interfaces/CodecOptions.md) & `object`

Defined in: [history/types.ts:7](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/history/types.ts#L7)

Options for [DynamoDBChatMessageHistory](../classes/DynamoDBChatMessageHistory.md).

## Type Declaration

### serde?

> `optional` **serde?**: `SerializerProtocol`

Optional serializer override (defaults to the JSON serializer).
