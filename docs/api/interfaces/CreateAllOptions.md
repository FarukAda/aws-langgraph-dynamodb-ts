[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / CreateAllOptions

# Interface: CreateAllOptions

Defined in: [factory/types.ts:55](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L55)

Per-adapter options for `DynamoDBFactory.createAll`; omit a section to skip
that adapter, and pass none to build none. A key that is not one of these
three is refused: it would otherwise skip every adapter silently.

## Properties

### history?

> `optional` **history?**: [`AdapterSection`](../type-aliases/AdapterSection.md)\<[`DynamoDBChatMessageHistoryOptions`](../type-aliases/DynamoDBChatMessageHistoryOptions.md)\>

Defined in: [factory/types.ts:58](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L58)

***

### saver?

> `optional` **saver?**: [`AdapterSection`](../type-aliases/AdapterSection.md)\<[`DynamoDBSaverOptions`](../type-aliases/DynamoDBSaverOptions.md)\>

Defined in: [factory/types.ts:56](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L56)

***

### store?

> `optional` **store?**: [`AdapterSection`](../type-aliases/AdapterSection.md)\<[`DynamoDBStoreOptions`](../type-aliases/DynamoDBStoreOptions.md)\>

Defined in: [factory/types.ts:57](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L57)
