[**AWS LangGraph DynamoDB TypeScript v0.1.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBStore

# Class: DynamoDBStore

Defined in: [store/index.ts:31](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/store/index.ts#L31)

## Extends

- `BaseStore`

## Constructors

### Constructor

> **new DynamoDBStore**(`options`): `DynamoDBStore`

Defined in: [store/index.ts:49](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/store/index.ts#L49)

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

Defined in: [store/index.ts:99](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/store/index.ts#L99)

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

Defined in: [store/index.ts:70](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/store/index.ts#L70)

Release underlying DynamoDB client resources.
Call this when the store is no longer needed to prevent resource leaks.
Skips cleanup if a shared client was injected via options.

#### Returns

`void`
