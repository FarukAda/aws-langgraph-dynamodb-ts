[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / RetryExhaustedError

# Class: RetryExhaustedError

Defined in: [shared/errors/errors.ts:43](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L43)

A retried operation exhausted its attempt budget.

## Extends

- [`DynamoDBLangGraphError`](DynamoDBLangGraphError.md)

## Constructors

### Constructor

> **new RetryExhaustedError**(`message`, `attempts?`, `cause?`): `RetryExhaustedError`

Defined in: [shared/errors/errors.ts:55](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L55)

Accepts: `attempts` — how many were made before the budget ran out. `cause` —
the last failure, kept so a caller can classify what actually went wrong.

Returns: the error, with `code: RETRY_EXHAUSTED` and `context.attempts`. It
says the attempts are spent, **not** that the operation did not happen: a
write whose response was lost is reported this way too, which is why every
caller that would delete something reads the row back first.

Throws: nothing; building an error may not fail.

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
