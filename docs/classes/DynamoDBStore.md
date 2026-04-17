[**AWS LangGraph DynamoDB TypeScript v0.2.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBStore

# Class: DynamoDBStore

Defined in: [store/index.ts:32](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/store/index.ts#L32)

## Extends

- `BaseStore`

## Constructors

### Constructor

> **new DynamoDBStore**(`options`): `DynamoDBStore`

Defined in: [store/index.ts:51](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/store/index.ts#L51)

Create a new DynamoDB store instance

#### Parameters

##### options

[`DynamoDBStoreOptions`](../interfaces/DynamoDBStoreOptions.md)

Configuration options for the store

#### Returns

`DynamoDBStore`

#### Overrides

`BaseStore.constructor`

## Methods

### batch()

> **batch**\<`Op`\>(`operations`, `config?`): `Promise`\<`OperationResults`\<`Op`\>\>

Defined in: [store/index.ts:98](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/store/index.ts#L98)

Execute a batch of operations in parallel

#### Type Parameters

##### Op

`Op` *extends* `Operation`[]

#### Parameters

##### operations

`Op`

Array of operations to execute

##### config?

`RunnableConfig`\<`Record`\<`string`, `any`\>\>

Runnable configuration containing user_id

#### Returns

`Promise`\<`OperationResults`\<`Op`\>\>

Array of results corresponding to each operation

#### Throws

Error if user_id is not provided in config or if any operation fails

#### Overrides

`BaseStore.batch`

***

### destroy()

> **destroy**(): `void`

Defined in: [store/index.ts:69](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/store/index.ts#L69)

Release underlying DynamoDB client resources.
Call this when the store is no longer needed to prevent resource leaks.
Skips cleanup if a shared client was injected via options.

#### Returns

`void`
