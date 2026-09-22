[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BatchWriteIncompleteError

# Class: BatchWriteIncompleteError

Defined in: [shared/errors/errors.ts:114](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L114)

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

Defined in: [shared/errors/errors.ts:132](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L132)

Accepts: `succeededCount` — writes DynamoDB acked. `unprocessed` — the
requests it did not, verbatim, so they can be re-submitted. `retries` —
rounds spent. `cause` — an error that interrupted the drain, rather than a
clean exhaustion of the budget.

Returns: the error, carrying both counts. Items *not* listed in `unprocessed`
persist: there is no rollback, so reconciliation is driven from that list.
That list is **copied**: it is read from a `catch` long after the throw, and
a caller reusing its request buffer must not be able to rewrite it.

Throws: nothing; building an error may not fail. Anything but an array of
requests reads as an empty list rather than crashing the report.

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

Defined in: [shared/errors/errors.ts:115](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L115)

***

### unprocessed

> `readonly` **unprocessed**: `WriteRequest`[]

Defined in: [shared/errors/errors.ts:116](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L116)
