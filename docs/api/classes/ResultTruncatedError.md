[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / ResultTruncatedError

# Class: ResultTruncatedError

Defined in: [shared/errors/errors.ts:67](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L67)

A paginated read hit its runaway guard (item or iteration cap) while more
data remained, so the result would have been silently truncated. Narrow the
query (filter/prefix) or raise the cap rather than trusting a partial result.
`context.field` names the cap that was hit.

## Extends

- [`DynamoDBLangGraphError`](DynamoDBLangGraphError.md)

## Constructors

### Constructor

> **new ResultTruncatedError**(`cap`, `limit`): `ResultTruncatedError`

Defined in: [shared/errors/errors.ts:78](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L78)

Accepts: `cap` — which cap was hit (`maxItems`, `maxIterations`). `limit` —
its value, quoted in the message so the fix is obvious.

Returns: the error, with `code: RESULT_TRUNCATED` and `context.field` naming
the cap. Raised only when data actually remained, so it never turns a
complete result into a failure.

Throws: nothing; building an error may not fail.

#### Parameters

##### cap

`string`

##### limit

`number`

#### Returns

`ResultTruncatedError`

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
