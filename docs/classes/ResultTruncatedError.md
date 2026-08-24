[**AWS LangGraph DynamoDB TypeScript v0.3.1**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / ResultTruncatedError

# Class: ResultTruncatedError

Defined in: [shared/errors/errors.ts:34](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/shared/errors/errors.ts#L34)

A paginated read hit its runaway guard (item or iteration cap) while more
data remained, so the result would have been silently truncated. Narrow the
query (filter/prefix) or raise the cap rather than trusting a partial result.

## Extends

- [`DynamoDbLangGraphError`](DynamoDbLangGraphError.md)

## Constructors

### Constructor

> **new ResultTruncatedError**(`cap`, `limit`): `ResultTruncatedError`

Defined in: [shared/errors/errors.ts:35](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/shared/errors/errors.ts#L35)

#### Parameters

##### cap

`string`

##### limit

`number`

#### Returns

`ResultTruncatedError`

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
