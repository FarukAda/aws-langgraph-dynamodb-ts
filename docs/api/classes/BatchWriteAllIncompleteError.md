[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BatchWriteAllIncompleteError

# Class: BatchWriteAllIncompleteError

Defined in: [shared/errors/errors.ts:92](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L92)

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

- [`DynamoDBLangGraphError`](DynamoDBLangGraphError.md)

## Constructors

### Constructor

> **new BatchWriteAllIncompleteError**(`succeededChunks`, `totalChunks`, `failedChunks`, `succeededCount?`): `BatchWriteAllIncompleteError`

Defined in: [shared/errors/errors.ts:98](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L98)

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

[`DynamoDBLangGraphError`](DynamoDBLangGraphError.md).[`constructor`](DynamoDBLangGraphError.md#constructor)

## Properties

### code

> `readonly` **code**: [`ErrorCode`](../enumerations/ErrorCode.md)

Defined in: [shared/errors/base-error.ts:29](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L29)

#### Inherited from

[`DynamoDBLangGraphError`](DynamoDBLangGraphError.md).[`code`](DynamoDBLangGraphError.md#code)

***

### context

> `readonly` **context**: [`ErrorContext`](../interfaces/ErrorContext.md)

Defined in: [shared/errors/base-error.ts:30](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L30)

#### Inherited from

[`DynamoDBLangGraphError`](DynamoDBLangGraphError.md).[`context`](DynamoDBLangGraphError.md#context)

***

### failedChunks

> `readonly` **failedChunks**: `Error`[]

Defined in: [shared/errors/errors.ts:95](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L95)

***

### succeededChunks

> `readonly` **succeededChunks**: `number`

Defined in: [shared/errors/errors.ts:93](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L93)

***

### succeededCount

> `readonly` **succeededCount**: `number`

Defined in: [shared/errors/errors.ts:96](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L96)

***

### totalChunks

> `readonly` **totalChunks**: `number`

Defined in: [shared/errors/errors.ts:94](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L94)
