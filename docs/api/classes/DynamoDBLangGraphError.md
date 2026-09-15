[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBLangGraphError

# Class: DynamoDBLangGraphError

Defined in: [shared/errors/base-error.ts:32](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L32)

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

Defined in: [shared/errors/base-error.ts:48](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L48)

Accepts: `message` — already redacted by whoever composed it, since it reaches
`err.message`, which an application may print without a redacting logger.
`context` — identifiers and counts only, never a payload or a credential.
`cause` — the failure below this one, kept as the native `cause` chain.

Returns: the error, branded so [isDynamoDBLangGraphError](../functions/isDynamoDBLangGraphError.md) recognises it
across realms and across two copies of this package. The brand is
non-enumerable, so it never reaches a log or a JSON serialization.

Throws: nothing; building an error may not fail.

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

Defined in: [shared/errors/base-error.ts:33](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L33)

***

### context

> `readonly` **context**: [`ErrorContext`](../interfaces/ErrorContext.md)

Defined in: [shared/errors/base-error.ts:34](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L34)
