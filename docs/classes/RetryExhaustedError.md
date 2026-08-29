[**AWS LangGraph DynamoDB TypeScript v0.9.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / RetryExhaustedError

# Class: RetryExhaustedError

Defined in: shared/errors/errors.ts:22

A retried operation exhausted its attempt budget.

## Extends

- [`DynamoDbLangGraphError`](DynamoDbLangGraphError.md)

## Constructors

### Constructor

> **new RetryExhaustedError**(`message`, `attempts?`, `cause?`): `RetryExhaustedError`

Defined in: shared/errors/errors.ts:23

#### Parameters

##### message

`string`

##### attempts?

`number`

##### cause?

`Error`

#### Returns

`RetryExhaustedError`

#### Overrides

[`DynamoDbLangGraphError`](DynamoDbLangGraphError.md).[`constructor`](DynamoDbLangGraphError.md#constructor)

## Properties

### code

> `readonly` **code**: [`ErrorCode`](../enumerations/ErrorCode.md)

Defined in: shared/errors/base-error.ts:20

#### Inherited from

[`DynamoDbLangGraphError`](DynamoDbLangGraphError.md).[`code`](DynamoDbLangGraphError.md#code)

***

### context

> `readonly` **context**: [`ErrorContext`](../interfaces/ErrorContext.md)

Defined in: shared/errors/base-error.ts:21

#### Inherited from

[`DynamoDbLangGraphError`](DynamoDbLangGraphError.md).[`context`](DynamoDbLangGraphError.md#context)
