[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BatchWriteAllIncompleteError

# Class: BatchWriteAllIncompleteError

Defined in: [shared/errors/errors.ts:153](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L153)

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

Defined in: [shared/errors/errors.ts:172](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L172)

Accepts: `succeededChunks`/`totalChunks` — the chunk tally.
`failedChunks` — each failing chunk's own error, commonly a
[BatchWriteIncompleteError](BatchWriteIncompleteError.md). `succeededCount` — individual writes
confirmed persisted across every chunk, which is more precise than the
chunk tally when a chunk partially drains.

Returns: the error, with the first failing chunk's error as `cause`. Every
chunk not represented in `failedChunks` drained successfully and its writes
persist — there is no rollback.

Throws: nothing; building an error may not fail.

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

Defined in: [shared/errors/base-error.ts:33](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L33)

#### Inherited from

[`DynamoDBLangGraphError`](DynamoDBLangGraphError.md).[`code`](DynamoDBLangGraphError.md#code)

***

### context

> `readonly` **context**: [`ErrorContext`](../interfaces/ErrorContext.md)

Defined in: [shared/errors/base-error.ts:34](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L34)

#### Inherited from

[`DynamoDBLangGraphError`](DynamoDBLangGraphError.md).[`context`](DynamoDBLangGraphError.md#context)

***

### failedChunks

> `readonly` **failedChunks**: `Error`[]

Defined in: [shared/errors/errors.ts:156](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L156)

***

### succeededChunks

> `readonly` **succeededChunks**: `number`

Defined in: [shared/errors/errors.ts:154](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L154)

***

### succeededCount

> `readonly` **succeededCount**: `number`

Defined in: [shared/errors/errors.ts:157](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L157)

***

### totalChunks

> `readonly` **totalChunks**: `number`

Defined in: [shared/errors/errors.ts:155](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L155)
