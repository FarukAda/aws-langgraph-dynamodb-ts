[**AWS LangGraph DynamoDB TypeScript v0.9.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDbLangGraphError

# Class: DynamoDbLangGraphError

Defined in: [shared/errors/base-error.ts:19](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/490338644b9a380688af6900c108cd966b84d00e/src/shared/errors/base-error.ts#L19)

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

Defined in: [shared/errors/base-error.ts:23](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/490338644b9a380688af6900c108cd966b84d00e/src/shared/errors/base-error.ts#L23)

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

Defined in: [shared/errors/base-error.ts:20](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/490338644b9a380688af6900c108cd966b84d00e/src/shared/errors/base-error.ts#L20)

***

### context

> `readonly` **context**: [`ErrorContext`](../interfaces/ErrorContext.md)

Defined in: [shared/errors/base-error.ts:21](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/490338644b9a380688af6900c108cd966b84d00e/src/shared/errors/base-error.ts#L21)
