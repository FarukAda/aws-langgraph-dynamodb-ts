[**AWS LangGraph DynamoDB TypeScript v0.3.1**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / CompensationFailedError

# Class: CompensationFailedError

Defined in: [shared/errors/errors.ts:80](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/shared/errors/errors.ts#L80)

A compensating rollback failed after an append-saga chunk error, so the
trigger error could not be cleanly undone. Carries the original trigger as
`cause` and the rollback failure as [rollbackError](#rollbackerror); the session's
`messageCount` may have drifted — repair it with `reconcileMessageCount`.

## Extends

- [`DynamoDbLangGraphError`](DynamoDbLangGraphError.md)

## Constructors

### Constructor

> **new CompensationFailedError**(`cause`, `rollbackError`): `CompensationFailedError`

Defined in: [shared/errors/errors.ts:83](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/shared/errors/errors.ts#L83)

#### Parameters

##### cause

`Error`

##### rollbackError

`Error`

#### Returns

`CompensationFailedError`

#### Overrides

[`DynamoDbLangGraphError`](DynamoDbLangGraphError.md).[`constructor`](DynamoDbLangGraphError.md#constructor)

## Properties

### code

> `readonly` **code**: [`ErrorCode`](../enumerations/ErrorCode.md)

Defined in: [shared/errors/base-error.ts:20](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/shared/errors/base-error.ts#L20)

#### Inherited from

[`DynamoDbLangGraphError`](DynamoDbLangGraphError.md).[`code`](DynamoDbLangGraphError.md#code)

***

### context

> `readonly` **context**: [`ErrorContext`](../interfaces/ErrorContext.md)

Defined in: [shared/errors/base-error.ts:21](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/shared/errors/base-error.ts#L21)

#### Inherited from

[`DynamoDbLangGraphError`](DynamoDbLangGraphError.md).[`context`](DynamoDbLangGraphError.md#context)

***

### rollbackError

> `readonly` **rollbackError**: `Error`

Defined in: [shared/errors/errors.ts:81](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/shared/errors/errors.ts#L81)
