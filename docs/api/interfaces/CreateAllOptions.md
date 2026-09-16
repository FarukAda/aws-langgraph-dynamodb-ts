[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / CreateAllOptions

# Interface: CreateAllOptions

Defined in: [factory/types.ts:57](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L57)

Per-adapter options for `DynamoDBFactory.createAll`; omit a section to skip
that adapter, and pass none to build none. A key that is not one of these
three is refused: it would otherwise skip every adapter silently. So is a
section that is not an object, `null` included, naming `options` as that
adapter's constructor would.

## Properties

### history?

> `optional` **history?**: [`AdapterSection`](../type-aliases/AdapterSection.md)\<[`DynamoDBChatMessageHistoryOptions`](../type-aliases/DynamoDBChatMessageHistoryOptions.md)\>

Defined in: [factory/types.ts:60](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L60)

***

### saver?

> `optional` **saver?**: [`AdapterSection`](../type-aliases/AdapterSection.md)\<[`DynamoDBSaverOptions`](../type-aliases/DynamoDBSaverOptions.md)\>

Defined in: [factory/types.ts:58](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L58)

***

### store?

> `optional` **store?**: [`AdapterSection`](../type-aliases/AdapterSection.md)\<[`DynamoDBStoreOptions`](../type-aliases/DynamoDBStoreOptions.md)\>

Defined in: [factory/types.ts:59](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L59)
