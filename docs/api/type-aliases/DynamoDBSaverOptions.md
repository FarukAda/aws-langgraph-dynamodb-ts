[**AWS LangGraph DynamoDB TypeScript v0.9.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBSaverOptions

# Type Alias: DynamoDBSaverOptions

> **DynamoDBSaverOptions** = [`BaseAdapterOptions`](../interfaces/BaseAdapterOptions.md) & [`CodecOptions`](../interfaces/CodecOptions.md) & `object`

Defined in: [checkpointer/types.ts:7](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/c3f018f37290d04fc34b7157d4ff279f0567c7f1/src/checkpointer/types.ts#L7)

Options for [DynamoDBSaver](../classes/DynamoDBSaver.md).

## Type Declaration

### serde?

> `optional` **serde?**: `SerializerProtocol`

Optional serializer override (defaults to LangGraph's JSON serializer).
