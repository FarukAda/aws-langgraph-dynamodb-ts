[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BatchWriteIncompleteError

# Class: BatchWriteIncompleteError

Defined in: [shared/errors/errors.ts:113](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L113)

A BatchWriteItem sequence could not drain its UnprocessedItems. Items NOT
listed in [unprocessed](#unprocessed) were acked by DynamoDB and persist — there is
no rollback (drive reconciliation from `unprocessed`). `cause`, when given,
is the underlying failure that interrupted the drain (e.g. a thrown,
non-UnprocessedItems error from a retry round) rather than a clean exhaustion
of the UnprocessedItems retry budget.

## Extends

- [`DynamoDBLangGraphError`](DynamoDBLangGraphError.md)

## Constructors

### Constructor

> **new BatchWriteIncompleteError**(`succeededCount`, `unprocessed`, `retries`, `cause?`): `BatchWriteIncompleteError`

Defined in: [shared/errors/errors.ts:128](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L128)

Accepts: `succeededCount` — writes DynamoDB acked. `unprocessed` — the
requests it did not, verbatim, so they can be re-submitted. `retries` —
rounds spent. `cause` — an error that interrupted the drain, rather than a
clean exhaustion of the budget.

Returns: the error, carrying both counts. Items *not* listed in `unprocessed`
persist: there is no rollback, so reconciliation is driven from that list.

Throws: nothing; building an error may not fail.

#### Parameters

##### succeededCount

`number`

##### unprocessed

`WriteRequest`[]

##### retries

`number`

##### cause?

`Error`

#### Returns

`BatchWriteIncompleteError`

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

### succeededCount

> `readonly` **succeededCount**: `number`

Defined in: [shared/errors/errors.ts:114](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L114)

***

### unprocessed

> `readonly` **unprocessed**: `WriteRequest`[]

Defined in: [shared/errors/errors.ts:115](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L115)
