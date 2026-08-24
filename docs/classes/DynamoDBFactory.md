[**AWS LangGraph DynamoDB TypeScript v0.3.1**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBFactory

# Class: DynamoDBFactory

Defined in: [factory/factory.ts:39](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/factory/factory.ts#L39)

Convenience constructors for the adapters. Individual `create*` methods each
build their own client; [createAll](#createall) builds one shared client used by all
three and returns a combined `destroy` that tears everything down once.

## Constructors

### Constructor

> **new DynamoDBFactory**(`base?`): `DynamoDBFactory`

Defined in: [factory/factory.ts:40](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/factory/factory.ts#L40)

#### Parameters

##### base?

[`FactoryBaseOptions`](../interfaces/FactoryBaseOptions.md) = `{}`

#### Returns

`DynamoDBFactory`

## Methods

### createAll()

> **createAll**(`options`): [`CreatedAdapters`](../interfaces/CreatedAdapters.md)

Defined in: [factory/factory.ts:54](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/factory/factory.ts#L54)

#### Parameters

##### options

[`CreateAllOptions`](../interfaces/CreateAllOptions.md)

#### Returns

[`CreatedAdapters`](../interfaces/CreatedAdapters.md)

***

### createChatMessageHistory()

> **createChatMessageHistory**(`options`): [`DynamoDBChatMessageHistory`](DynamoDBChatMessageHistory.md)

Defined in: [factory/factory.ts:50](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/factory/factory.ts#L50)

#### Parameters

##### options

[`DynamoDBChatMessageHistoryOptions`](../type-aliases/DynamoDBChatMessageHistoryOptions.md)

#### Returns

[`DynamoDBChatMessageHistory`](DynamoDBChatMessageHistory.md)

***

### createSaver()

> **createSaver**(`options`): [`DynamoDBSaver`](DynamoDBSaver.md)

Defined in: [factory/factory.ts:42](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/factory/factory.ts#L42)

#### Parameters

##### options

[`DynamoDBSaverOptions`](../type-aliases/DynamoDBSaverOptions.md)

#### Returns

[`DynamoDBSaver`](DynamoDBSaver.md)

***

### createStore()

> **createStore**(`options`): [`DynamoDBStore`](DynamoDBStore.md)

Defined in: [factory/factory.ts:46](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/factory/factory.ts#L46)

#### Parameters

##### options

[`DynamoDBStoreOptions`](../type-aliases/DynamoDBStoreOptions.md)

#### Returns

[`DynamoDBStore`](DynamoDBStore.md)
