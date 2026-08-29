[**AWS LangGraph DynamoDB TypeScript v0.9.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / CreatedAdapters

# Interface: CreatedAdapters

Defined in: factory/factory.ts:29

The three adapters sharing one client, plus a combined `destroy`.

## Properties

### destroy

> **destroy**: () => `void`

Defined in: factory/factory.ts:33

#### Returns

`void`

***

### history

> **history**: [`DynamoDBChatMessageHistory`](../classes/DynamoDBChatMessageHistory.md)

Defined in: factory/factory.ts:32

***

### saver

> **saver**: [`DynamoDBSaver`](../classes/DynamoDBSaver.md)

Defined in: factory/factory.ts:30

***

### store

> **store**: [`DynamoDBStore`](../classes/DynamoDBStore.md)

Defined in: factory/factory.ts:31
