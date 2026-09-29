[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBChatMessageHistoryOptions

# Type Alias: DynamoDBChatMessageHistoryOptions

> **DynamoDBChatMessageHistoryOptions** = [`BaseAdapterOptions`](../interfaces/BaseAdapterOptions.md) & [`CodecOptions`](../interfaces/CodecOptions.md) & `object`

Defined in: [history/types.ts:17](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/types.ts#L17)

Options for [DynamoDBChatMessageHistory](../classes/DynamoDBChatMessageHistory.md).

## Type Declaration

### onCorruptMessage?

> `optional` **onCorruptMessage?**: [`CorruptMessagePolicy`](CorruptMessagePolicy.md)

What `getMessages` does when a stored message cannot be decoded. It
covers a payload nobody can read — bytes that are no longer the form
the row declares, a gone S3 object, a descriptor that is not one — and
a stored message LangChain cannot rebuild. It does not govern a
payload larger than this reader's `compression.maxDecompressedBytes`
or `s3.maxDownloadBytes` (a limit of this reader's, not a lost
payload), nor a serializer declining intact bytes: a `serdeType` the
configured serializer has no grammar for after a config change, like
an `lc` record naming a class outside its allow-list, is reported
under **both** policies, because a payload this reader merely may not
rebuild is not a payload that is gone. `'skip'` (the default) drops
the item, logs it at `error` with its sort key so an operator can
locate it, and returns the rest; `'throw'` fails the whole read, which
is all-or-nothing but leaves the session unreadable until the bad row
is removed out of band.

### serde?

> `optional` **serde?**: `SerializerProtocol`

Optional serializer override. The default is the exported `JSON_SERDE`,
plain JSON: what it stores is the JSON projection of a value, and the
README's *Table schema* section tabulates where that differs from the
value itself.
