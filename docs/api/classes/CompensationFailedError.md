[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / CompensationFailedError

# Class: CompensationFailedError

Defined in: [shared/errors/errors.ts:209](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L209)

A compensating rollback failed after an append-saga chunk error, so the
trigger error could not be cleanly undone. Carries the original trigger as
`cause` and the rollback failure as [rollbackError](#rollbackerror); the session's
`messageCount` may have drifted — repair it with `reconcileMessageCount`.

## Extends

- [`DynamoDBLangGraphError`](DynamoDBLangGraphError.md)

## Constructors

### Constructor

> **new CompensationFailedError**(`cause`, `rollbackError`): `CompensationFailedError`

Defined in: [shared/errors/errors.ts:222](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L222)

Accepts: `cause` — the failure that triggered the rollback. `rollbackError` —
why the rollback itself could not finish.

Returns: the error, carrying both. The session's `messageCount` may have
drifted, which `reconcileMessageCount` repairs; the quoted text of both
errors is redacted before it is embedded.

Throws: nothing; building an error may not fail.

#### Parameters

##### cause

`Error`

##### rollbackError

`Error`

#### Returns

`CompensationFailedError`

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

### rollbackError

> `readonly` **rollbackError**: `Error`

Defined in: [shared/errors/errors.ts:210](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L210)
