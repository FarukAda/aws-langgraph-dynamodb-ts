[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / WriteRequest

# Type Alias: WriteRequest

> **WriteRequest** = \{ `PutRequest`: \{ `Item`: `Record`\<`string`, `NativeAttributeValue`\>; \}; \} \| \{ `DeleteRequest`: \{ `Key`: `Record`\<`string`, `NativeAttributeValue`\>; \}; \}

Defined in: [shared/dynamodb/client.ts:213](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/client.ts#L213)

A single `BatchWriteItem` write request, as the document client takes it —
a `PutRequest` carrying the item, or a `DeleteRequest` carrying the key:
the shape of each entry a `BATCH_WRITE_INCOMPLETE` error's
`details.unprocessed` carries, verbatim, so a caller can re-submit it.
