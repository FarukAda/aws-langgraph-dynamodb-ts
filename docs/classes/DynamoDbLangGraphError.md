[**AWS LangGraph DynamoDB TypeScript v0.9.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDbLangGraphError

# Class: DynamoDbLangGraphError

Defined in: shared/errors/base-error.ts:19

Base class for every error this library throws. Carries a branchable
[ErrorCode](../enumerations/ErrorCode.md), structured [ErrorContext](../interfaces/ErrorContext.md), and a native `cause`
chain. Detected via isDynamoDbLangGraphError (a symbol brand) rather
than `instanceof`, which is banned repo-wide.

## Extends

- `Error`

## Extended by

- [`AbortError`](AbortError.md)
- [`BatchWriteAllIncompleteError`](BatchWriteAllIncompleteError.md)
- [`BatchWriteIncompleteError`](BatchWriteIncompleteError.md)
- [`CompensationFailedError`](CompensationFailedError.md)
- [`ConflictError`](ConflictError.md)
- [`ResultTruncatedError`](ResultTruncatedError.md)
- [`RetryExhaustedError`](RetryExhaustedError.md)
- [`ValidationError`](ValidationError.md)

## Constructors

### Constructor

> **new DynamoDbLangGraphError**(`message`, `code`, `context?`, `cause?`): `DynamoDbLangGraphError`

Defined in: shared/errors/base-error.ts:23

#### Parameters

##### message

`string`

##### code

[`ErrorCode`](../enumerations/ErrorCode.md)

##### context?

[`ErrorContext`](../interfaces/ErrorContext.md) = `{}`

##### cause?

`Error`

#### Returns

`DynamoDbLangGraphError`

#### Overrides

`Error.constructor`

## Properties

### code

> `readonly` **code**: [`ErrorCode`](../enumerations/ErrorCode.md)

Defined in: shared/errors/base-error.ts:20

***

### context

> `readonly` **context**: [`ErrorContext`](../interfaces/ErrorContext.md)

Defined in: shared/errors/base-error.ts:21
