[**AWS LangGraph DynamoDB TypeScript v0.8.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / CreatedAdapters

# Interface: CreatedAdapters

Defined in: [factory/factory.ts:29](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/factory/factory.ts#L29)

The three adapters sharing one client, plus a combined `destroy`.

## Properties

### destroy

> **destroy**: () => `void`

Defined in: [factory/factory.ts:33](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/factory/factory.ts#L33)

#### Returns

`void`

***

### history

> **history**: [`DynamoDBChatMessageHistory`](../classes/DynamoDBChatMessageHistory.md)

Defined in: [factory/factory.ts:32](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/factory/factory.ts#L32)

***

### saver

> **saver**: [`DynamoDBSaver`](../classes/DynamoDBSaver.md)

Defined in: [factory/factory.ts:30](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/factory/factory.ts#L30)

***

### store

> **store**: [`DynamoDBStore`](../classes/DynamoDBStore.md)

Defined in: [factory/factory.ts:31](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/factory/factory.ts#L31)
