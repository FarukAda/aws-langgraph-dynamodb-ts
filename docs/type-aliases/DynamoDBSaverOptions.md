[**AWS LangGraph DynamoDB TypeScript v0.8.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBSaverOptions

# Type Alias: DynamoDBSaverOptions

> **DynamoDBSaverOptions** = [`BaseAdapterOptions`](../interfaces/BaseAdapterOptions.md) & [`CodecOptions`](../interfaces/CodecOptions.md) & `object`

Defined in: [checkpointer/types.ts:7](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/764a36f34f1f6210c41e72e5aa36bf1198e2d7c2/src/checkpointer/types.ts#L7)

Options for [DynamoDBSaver](../classes/DynamoDBSaver.md).

## Type Declaration

### serde?

> `optional` **serde?**: `SerializerProtocol`

Optional serializer override (defaults to LangGraph's JSON serializer).
