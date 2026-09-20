[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BatchWriteAllIncompleteError

# Class: BatchWriteAllIncompleteError

Defined in: [shared/errors/errors.ts:158](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L158)

batchWriteAll attempts every chunk rather than stopping at the first
failure — a mid-sequence chunk failing does not abandon the chunks after
it. `failedChunks` holds each failing chunk's own error (commonly a
[BatchWriteIncompleteError](BatchWriteIncompleteError.md)); every chunk not represented there
drained successfully and its writes persist — there is no rollback.
`succeededCount` is the exact number of individual write requests
confirmed persisted across every chunk (full chunks plus any failed
chunk's own partial drain), more precise than `succeededChunks` alone
when a chunk partially drains before exhausting its retries.

A partition-wide delete reports through the same error, because what it
answers is the same question — how much of this call got through — but it
sends one conditional request per row rather than a batch of twenty-five, so
it counts rows where this counts chunks and says so in its message.

## Extends

- [`DynamoDBLangGraphError`](DynamoDBLangGraphError.md)

## Constructors

### Constructor

> **new BatchWriteAllIncompleteError**(`succeededChunks`, `totalChunks`, `failedChunks`, `succeededCount?`, `unit?`): `BatchWriteAllIncompleteError`

Defined in: [shared/errors/errors.ts:180](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L180)

Accepts: `succeededChunks`/`totalChunks` — the chunk tally.
`failedChunks` — each failing chunk's own error, commonly a
[BatchWriteIncompleteError](BatchWriteIncompleteError.md). `succeededCount` — individual writes
confirmed persisted across every chunk, which is more precise than the
chunk tally when a chunk partially drains. `unit` — what the first two
counts count, so a caller that sends one conditional request per row rather
than a batch of twenty-five is not described as a batch that did not drain;
omitting it reproduces the batch wording exactly.

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

##### unit?

`"chunk"` \| `"row"`

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

Defined in: [shared/errors/errors.ts:161](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L161)

***

### succeededChunks

> `readonly` **succeededChunks**: `number`

Defined in: [shared/errors/errors.ts:159](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L159)

***

### succeededCount

> `readonly` **succeededCount**: `number`

Defined in: [shared/errors/errors.ts:162](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L162)

***

### totalChunks

> `readonly` **totalChunks**: `number`

Defined in: [shared/errors/errors.ts:160](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L160)
