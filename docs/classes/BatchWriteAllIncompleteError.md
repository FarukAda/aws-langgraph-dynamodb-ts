[**AWS LangGraph DynamoDB TypeScript v0.8.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BatchWriteAllIncompleteError

# Class: BatchWriteAllIncompleteError

Defined in: [shared/errors/errors.ts:90](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/b9d505b52648c7e723f3e953aac58e9fe52a329f/src/shared/errors/errors.ts#L90)

batchWriteAll attempts every chunk rather than stopping at the first
failure — a mid-sequence chunk failing does not abandon the chunks after
it. `failedChunks` holds each failing chunk's own error (commonly a
[BatchWriteIncompleteError](BatchWriteIncompleteError.md)); every chunk not represented there
drained successfully and its writes persist — there is no rollback.
`succeededCount` is the exact number of individual write requests
confirmed persisted across every chunk (full chunks plus any failed
chunk's own partial drain), more precise than `succeededChunks` alone
when a chunk partially drains before exhausting its retries.

## Extends

- [`DynamoDbLangGraphError`](DynamoDbLangGraphError.md)

## Constructors

### Constructor

> **new BatchWriteAllIncompleteError**(`succeededChunks`, `totalChunks`, `failedChunks`, `succeededCount?`): `BatchWriteAllIncompleteError`

Defined in: [shared/errors/errors.ts:96](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/b9d505b52648c7e723f3e953aac58e9fe52a329f/src/shared/errors/errors.ts#L96)

#### Parameters

##### succeededChunks

`number`

##### totalChunks

`number`

##### failedChunks

`Error`[]

##### succeededCount?

`number` = `0`

#### Returns

`BatchWriteAllIncompleteError`

#### Overrides

[`DynamoDbLangGraphError`](DynamoDbLangGraphError.md).[`constructor`](DynamoDbLangGraphError.md#constructor)

## Properties

### code

> `readonly` **code**: [`ErrorCode`](../enumerations/ErrorCode.md)

Defined in: [shared/errors/base-error.ts:20](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/b9d505b52648c7e723f3e953aac58e9fe52a329f/src/shared/errors/base-error.ts#L20)

#### Inherited from

[`DynamoDbLangGraphError`](DynamoDbLangGraphError.md).[`code`](DynamoDbLangGraphError.md#code)

***

### context

> `readonly` **context**: [`ErrorContext`](../interfaces/ErrorContext.md)

Defined in: [shared/errors/base-error.ts:21](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/b9d505b52648c7e723f3e953aac58e9fe52a329f/src/shared/errors/base-error.ts#L21)

#### Inherited from

[`DynamoDbLangGraphError`](DynamoDbLangGraphError.md).[`context`](DynamoDbLangGraphError.md#context)

***

### failedChunks

> `readonly` **failedChunks**: `Error`[]

Defined in: [shared/errors/errors.ts:93](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/b9d505b52648c7e723f3e953aac58e9fe52a329f/src/shared/errors/errors.ts#L93)

***

### succeededChunks

> `readonly` **succeededChunks**: `number`

Defined in: [shared/errors/errors.ts:91](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/b9d505b52648c7e723f3e953aac58e9fe52a329f/src/shared/errors/errors.ts#L91)

***

### succeededCount

> `readonly` **succeededCount**: `number`

Defined in: [shared/errors/errors.ts:94](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/b9d505b52648c7e723f3e953aac58e9fe52a329f/src/shared/errors/errors.ts#L94)

***

### totalChunks

> `readonly` **totalChunks**: `number`

Defined in: [shared/errors/errors.ts:92](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/b9d505b52648c7e723f3e953aac58e9fe52a329f/src/shared/errors/errors.ts#L92)
