[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBSaverOptions

# Type Alias: DynamoDBSaverOptions

> **DynamoDBSaverOptions** = [`BaseAdapterOptions`](../interfaces/BaseAdapterOptions.md) & [`CodecOptions`](../interfaces/CodecOptions.md) & `object`

Defined in: [checkpointer/types.ts:7](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/types.ts#L7)

Options for [DynamoDBSaver](../classes/DynamoDBSaver.md).

## Type Declaration

### serde?

> `optional` **serde?**: `SerializerProtocol`

Optional serializer override (defaults to LangGraph's JSON serializer).
