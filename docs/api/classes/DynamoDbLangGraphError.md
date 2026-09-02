[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBLangGraphError

# Class: DynamoDBLangGraphError

Defined in: [shared/errors/base-error.ts:28](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L28)

Base class for every error this library throws. Carries a branchable
[ErrorCode](../enumerations/ErrorCode.md), structured [ErrorContext](../interfaces/ErrorContext.md), and a native `cause`
chain. Detected via [isDynamoDBLangGraphError](../functions/isDynamoDBLangGraphError.md) (a symbol brand) rather
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
- [`UpstreamError`](UpstreamError.md)

## Constructors

### Constructor

> **new DynamoDBLangGraphError**(`message`, `code`, `context?`, `cause?`): `DynamoDBLangGraphError`

Defined in: [shared/errors/base-error.ts:32](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L32)

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

`DynamoDBLangGraphError`

#### Overrides

`Error.constructor`

## Properties

### code

> `readonly` **code**: [`ErrorCode`](../enumerations/ErrorCode.md)

Defined in: [shared/errors/base-error.ts:29](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L29)

***

### context

> `readonly` **context**: [`ErrorContext`](../interfaces/ErrorContext.md)

Defined in: [shared/errors/base-error.ts:30](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L30)
