[**AWS LangGraph DynamoDB TypeScript v0.8.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBFactory

# Class: DynamoDBFactory

Defined in: [factory/factory.ts:41](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/764a36f34f1f6210c41e72e5aa36bf1198e2d7c2/src/factory/factory.ts#L41)

Convenience constructors for the adapters. Individual `create*` methods each
build their own client; [createAll](#createall) builds one shared client used by all
three and returns a combined `destroy` that tears everything down once.

## Constructors

### Constructor

> **new DynamoDBFactory**(`base?`): `DynamoDBFactory`

Defined in: [factory/factory.ts:42](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/764a36f34f1f6210c41e72e5aa36bf1198e2d7c2/src/factory/factory.ts#L42)

#### Parameters

##### base?

[`FactoryBaseOptions`](../interfaces/FactoryBaseOptions.md) = `{}`

#### Returns

`DynamoDBFactory`

## Methods

### createAll()

> **createAll**(`options`): [`CreatedAdapters`](../interfaces/CreatedAdapters.md)

Defined in: [factory/factory.ts:56](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/764a36f34f1f6210c41e72e5aa36bf1198e2d7c2/src/factory/factory.ts#L56)

#### Parameters

##### options

[`CreateAllOptions`](../interfaces/CreateAllOptions.md)

#### Returns

[`CreatedAdapters`](../interfaces/CreatedAdapters.md)

***

### createChatMessageHistory()

> **createChatMessageHistory**(`options`): [`DynamoDBChatMessageHistory`](DynamoDBChatMessageHistory.md)

Defined in: [factory/factory.ts:52](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/764a36f34f1f6210c41e72e5aa36bf1198e2d7c2/src/factory/factory.ts#L52)

#### Parameters

##### options

[`DynamoDBChatMessageHistoryOptions`](../type-aliases/DynamoDBChatMessageHistoryOptions.md)

#### Returns

[`DynamoDBChatMessageHistory`](DynamoDBChatMessageHistory.md)

***

### createSaver()

> **createSaver**(`options`): [`DynamoDBSaver`](DynamoDBSaver.md)

Defined in: [factory/factory.ts:44](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/764a36f34f1f6210c41e72e5aa36bf1198e2d7c2/src/factory/factory.ts#L44)

#### Parameters

##### options

[`DynamoDBSaverOptions`](../type-aliases/DynamoDBSaverOptions.md)

#### Returns

[`DynamoDBSaver`](DynamoDBSaver.md)

***

### createStore()

> **createStore**(`options`): [`DynamoDBStore`](DynamoDBStore.md)

Defined in: [factory/factory.ts:48](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/764a36f34f1f6210c41e72e5aa36bf1198e2d7c2/src/factory/factory.ts#L48)

#### Parameters

##### options

[`DynamoDBStoreOptions`](../type-aliases/DynamoDBStoreOptions.md)

#### Returns

[`DynamoDBStore`](DynamoDBStore.md)
