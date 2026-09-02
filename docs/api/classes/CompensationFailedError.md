[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / CompensationFailedError

# Class: CompensationFailedError

Defined in: [shared/errors/errors.ts:125](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/errors/errors.ts#L125)

A compensating rollback failed after an append-saga chunk error, so the
trigger error could not be cleanly undone. Carries the original trigger as
`cause` and the rollback failure as [rollbackError](#rollbackerror); the session's
`messageCount` may have drifted — repair it with `reconcileMessageCount`.

## Extends

- [`DynamoDBLangGraphError`](DynamoDBLangGraphError.md)

## Constructors

### Constructor

> **new CompensationFailedError**(`cause`, `rollbackError`): `CompensationFailedError`

Defined in: [shared/errors/errors.ts:128](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/errors/errors.ts#L128)

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

Defined in: [shared/errors/base-error.ts:29](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/errors/base-error.ts#L29)

#### Inherited from

[`DynamoDBLangGraphError`](DynamoDBLangGraphError.md).[`code`](DynamoDBLangGraphError.md#code)

***

### context

> `readonly` **context**: [`ErrorContext`](../interfaces/ErrorContext.md)

Defined in: [shared/errors/base-error.ts:30](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/errors/base-error.ts#L30)

#### Inherited from

[`DynamoDBLangGraphError`](DynamoDBLangGraphError.md).[`context`](DynamoDBLangGraphError.md#context)

***

### rollbackError

> `readonly` **rollbackError**: `Error`

Defined in: [shared/errors/errors.ts:126](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/errors/errors.ts#L126)
