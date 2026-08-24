[**AWS LangGraph DynamoDB TypeScript v0.3.1**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / CreatedAdapters

# Interface: CreatedAdapters

Defined in: [factory/factory.ts:27](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/factory/factory.ts#L27)

The three adapters sharing one client, plus a combined `destroy`.

## Properties

### destroy

> **destroy**: () => `void`

Defined in: [factory/factory.ts:31](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/factory/factory.ts#L31)

#### Returns

`void`

***

### history

> **history**: [`DynamoDBChatMessageHistory`](../classes/DynamoDBChatMessageHistory.md)

Defined in: [factory/factory.ts:30](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/factory/factory.ts#L30)

***

### saver

> **saver**: [`DynamoDBSaver`](../classes/DynamoDBSaver.md)

Defined in: [factory/factory.ts:28](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/factory/factory.ts#L28)

***

### store

> **store**: [`DynamoDBStore`](../classes/DynamoDBStore.md)

Defined in: [factory/factory.ts:29](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/factory/factory.ts#L29)
