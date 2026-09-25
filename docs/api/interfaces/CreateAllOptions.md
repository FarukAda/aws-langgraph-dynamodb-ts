[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / CreateAllOptions

# Interface: CreateAllOptions

Defined in: [factory/types.ts:66](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L66)

Per-adapter options for `DynamoDBFactory.createAll`; omit a section to skip
that adapter, and pass none to build none. A key that is not one of these
three is refused: it would otherwise skip every adapter silently. So is a
section that is not an object, `null` included, naming `options` as that
adapter's constructor would.

## Properties

### history?

> `optional` **history?**: [`AdapterSection`](../type-aliases/AdapterSection.md)\<[`DynamoDBChatMessageHistoryOptions`](../type-aliases/DynamoDBChatMessageHistoryOptions.md)\>

Defined in: [factory/types.ts:69](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L69)

***

### saver?

> `optional` **saver?**: [`AdapterSection`](../type-aliases/AdapterSection.md)\<[`DynamoDBSaverOptions`](../type-aliases/DynamoDBSaverOptions.md)\>

Defined in: [factory/types.ts:67](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L67)

***

### store?

> `optional` **store?**: [`AdapterSection`](../type-aliases/AdapterSection.md)\<[`DynamoDBStoreOptions`](../type-aliases/DynamoDBStoreOptions.md)\>

Defined in: [factory/types.ts:68](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L68)
