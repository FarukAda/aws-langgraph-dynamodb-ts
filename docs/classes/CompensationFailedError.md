[**AWS LangGraph DynamoDB TypeScript v0.8.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / CompensationFailedError

# Class: CompensationFailedError

Defined in: [shared/errors/errors.ts:123](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/shared/errors/errors.ts#L123)

A compensating rollback failed after an append-saga chunk error, so the
trigger error could not be cleanly undone. Carries the original trigger as
`cause` and the rollback failure as [rollbackError](#rollbackerror); the session's
`messageCount` may have drifted — repair it with `reconcileMessageCount`.

## Extends

- [`DynamoDbLangGraphError`](DynamoDbLangGraphError.md)

## Constructors

### Constructor

> **new CompensationFailedError**(`cause`, `rollbackError`): `CompensationFailedError`

Defined in: [shared/errors/errors.ts:126](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/shared/errors/errors.ts#L126)

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

Defined in: [shared/errors/base-error.ts:20](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/shared/errors/base-error.ts#L20)

#### Inherited from

[`DynamoDbLangGraphError`](DynamoDbLangGraphError.md).[`code`](DynamoDbLangGraphError.md#code)

***

### context

> `readonly` **context**: [`ErrorContext`](../interfaces/ErrorContext.md)

Defined in: [shared/errors/base-error.ts:21](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/shared/errors/base-error.ts#L21)

#### Inherited from

[`DynamoDbLangGraphError`](DynamoDbLangGraphError.md).[`context`](DynamoDbLangGraphError.md#context)

***

### rollbackError

> `readonly` **rollbackError**: `Error`

Defined in: [shared/errors/errors.ts:124](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/shared/errors/errors.ts#L124)
