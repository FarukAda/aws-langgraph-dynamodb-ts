[**AWS LangGraph DynamoDB TypeScript v0.8.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBChatMessageHistoryOptions

# Type Alias: DynamoDBChatMessageHistoryOptions

> **DynamoDBChatMessageHistoryOptions** = [`BaseAdapterOptions`](../interfaces/BaseAdapterOptions.md) & [`CodecOptions`](../interfaces/CodecOptions.md) & `object`

Defined in: [history/types.ts:7](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/764a36f34f1f6210c41e72e5aa36bf1198e2d7c2/src/history/types.ts#L7)

Options for [DynamoDBChatMessageHistory](../classes/DynamoDBChatMessageHistory.md).

## Type Declaration

### onCorruptMessage?

> `optional` **onCorruptMessage?**: [`CorruptMessagePolicy`](CorruptMessagePolicy.md)

What `getMessages` does when a stored message cannot be decoded — a
decompression-guard trip, an unsupported `serdeType` after a config
change, or genuinely corrupted bytes. `'skip'` (the default) drops the
item, logs it at `error` with its sort key so an operator can locate
it, and returns the rest; `'throw'` fails the whole read, which is
all-or-nothing but leaves the session unreadable until the bad row is
removed out of band.

### serde?

> `optional` **serde?**: `SerializerProtocol`

Optional serializer override (defaults to the JSON serializer).
