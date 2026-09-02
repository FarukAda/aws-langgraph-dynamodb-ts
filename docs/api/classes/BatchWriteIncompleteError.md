[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BatchWriteIncompleteError

# Class: BatchWriteIncompleteError

Defined in: [shared/errors/errors.ts:63](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L63)

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

Defined in: [shared/errors/errors.ts:67](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L67)

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

### succeededCount

> `readonly` **succeededCount**: `number`

Defined in: [shared/errors/errors.ts:64](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L64)

***

### unprocessed

> `readonly` **unprocessed**: `WriteRequest`[]

Defined in: [shared/errors/errors.ts:65](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L65)
