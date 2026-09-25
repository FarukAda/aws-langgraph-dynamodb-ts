[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBSaverOptions

# Type Alias: DynamoDBSaverOptions

> **DynamoDBSaverOptions** = [`BaseAdapterOptions`](../interfaces/BaseAdapterOptions.md) & [`CodecOptions`](../interfaces/CodecOptions.md) & `object`

Defined in: [checkpointer/types.ts:18](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/types.ts#L18)

Options for [DynamoDBSaver](../classes/DynamoDBSaver.md).

## Type Declaration

### serde?

> `optional` **serde?**: `SerializerProtocol`

Optional serializer override. The default is the base class's, which is
LangGraph's `JsonPlusSerializer` — **not** the plain JSON serializer the
store and chat-history adapters default to. The two differ on read as
well as on write: `JsonPlusSerializer` reconstructs a `Map`, a `Set`, a
`Uint8Array` or an allow-listed `langchain_core` class from the `lc`
record a stored row carries, so the row selects which constructor runs,
while plain JSON parses and reconstructs nothing. Pass the exported
`JSON_SERDE` for the narrower read path, at the cost of the JSON
projection the README's *Table schema* section tabulates.
