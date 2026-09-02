[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBFactory

# Class: DynamoDBFactory

Defined in: [factory/factory.ts:39](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/factory.ts#L39)

Convenience constructors for the adapters. Individual `create*` methods each
build their own client; [createAll](#createall) builds one shared client used by all
three and returns a combined `destroy` that tears everything down once.

## Constructors

### Constructor

> **new DynamoDBFactory**(`base?`): `DynamoDBFactory`

Defined in: [factory/factory.ts:40](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/factory.ts#L40)

#### Parameters

##### base?

[`FactoryBaseOptions`](../interfaces/FactoryBaseOptions.md) = `{}`

#### Returns

`DynamoDBFactory`

## Methods

### createAll()

> **createAll**\<`O`\>(`options`): [`CreatedAdapters`](../interfaces/CreatedAdapters.md)\<`O`\>

Defined in: [factory/factory.ts:81](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/factory.ts#L81)

Build the adapters whose sections are given, all on one shared client and
with the factory's shared defaults underneath each section. If any
constructor throws (a store with `vectorBackend` but no `index`, say), the
adapters already built and the freshly created client are destroyed
before the error propagates, so a failed call leaks nothing.

#### Type Parameters

##### O

`O` *extends* [`CreateAllOptions`](../interfaces/CreateAllOptions.md)

#### Parameters

##### options

`O`

#### Returns

[`CreatedAdapters`](../interfaces/CreatedAdapters.md)\<`O`\>

***

### createChatMessageHistory()

> **createChatMessageHistory**(`options`): [`DynamoDBChatMessageHistory`](DynamoDBChatMessageHistory.md)

Defined in: [factory/factory.ts:70](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/factory.ts#L70)

A chat history on its own client, with the factory's shared defaults underneath `options`.

#### Parameters

##### options

[`DynamoDBChatMessageHistoryOptions`](../type-aliases/DynamoDBChatMessageHistoryOptions.md)

#### Returns

[`DynamoDBChatMessageHistory`](DynamoDBChatMessageHistory.md)

***

### createSaver()

> **createSaver**(`options`): [`DynamoDBSaver`](DynamoDBSaver.md)

Defined in: [factory/factory.ts:60](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/factory.ts#L60)

A saver on its own client, with the factory's shared defaults underneath `options`.

#### Parameters

##### options

[`DynamoDBSaverOptions`](../type-aliases/DynamoDBSaverOptions.md)

#### Returns

[`DynamoDBSaver`](DynamoDBSaver.md)

***

### createStore()

> **createStore**(`options`): [`DynamoDBStore`](DynamoDBStore.md)

Defined in: [factory/factory.ts:65](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/factory.ts#L65)

A store on its own client, with the factory's shared defaults underneath `options`.

#### Parameters

##### options

[`DynamoDBStoreOptions`](../type-aliases/DynamoDBStoreOptions.md)

#### Returns

[`DynamoDBStore`](DynamoDBStore.md)
