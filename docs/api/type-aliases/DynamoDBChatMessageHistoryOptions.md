[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBChatMessageHistoryOptions

# Type Alias: DynamoDBChatMessageHistoryOptions

> **DynamoDBChatMessageHistoryOptions** = [`BaseAdapterOptions`](../interfaces/BaseAdapterOptions.md) & [`CodecOptions`](../interfaces/CodecOptions.md) & `object`

Defined in: [history/types.ts:16](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L16)

Options for [DynamoDBChatMessageHistory](../classes/DynamoDBChatMessageHistory.md).

## Type Declaration

### onCorruptMessage?

> `optional` **onCorruptMessage?**: [`CorruptMessagePolicy`](CorruptMessagePolicy.md)

What `getMessages` does when a stored message cannot be decoded — a
decompression-guard trip, bytes that no longer parse as the form the row
declares, or a decoded message LangChain cannot rebuild. A serializer
declining intact bytes is not one of these and this option does not
govern it: a `serdeType` the configured serializer has no grammar for
after a config change, like an `lc` record naming a class outside its
allow-list, is reported under **both** policies, because a payload this
reader merely may not rebuild is not a payload that is gone. `'skip'`
(the default) drops the item, logs it at `error` with its sort key so an
operator can locate it, and returns the rest; `'throw'` fails the whole
read, which is all-or-nothing but leaves the session unreadable until
the bad row is removed out of band.

### serde?

> `optional` **serde?**: `SerializerProtocol`

Optional serializer override. The default is the exported `JSON_SERDE`,
plain JSON: what it stores is the JSON projection of a value, and the
README's *Table schema* section tabulates where that differs from the
value itself.
