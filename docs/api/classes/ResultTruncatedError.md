[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / ResultTruncatedError

# Class: ResultTruncatedError

Defined in: [shared/errors/errors.ts:36](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/errors/errors.ts#L36)

A paginated read hit its runaway guard (item or iteration cap) while more
data remained, so the result would have been silently truncated. Narrow the
query (filter/prefix) or raise the cap rather than trusting a partial result.
`context.field` names the cap that was hit.

## Extends

- [`DynamoDBLangGraphError`](DynamoDBLangGraphError.md)

## Constructors

### Constructor

> **new ResultTruncatedError**(`cap`, `limit`): `ResultTruncatedError`

Defined in: [shared/errors/errors.ts:37](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/errors/errors.ts#L37)

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

Defined in: [shared/errors/base-error.ts:29](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/errors/base-error.ts#L29)

#### Inherited from

[`DynamoDBLangGraphError`](DynamoDBLangGraphError.md).[`code`](DynamoDBLangGraphError.md#code)

***

### context

> `readonly` **context**: [`ErrorContext`](../interfaces/ErrorContext.md)

Defined in: [shared/errors/base-error.ts:30](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/errors/base-error.ts#L30)

#### Inherited from

[`DynamoDBLangGraphError`](DynamoDBLangGraphError.md).[`context`](DynamoDBLangGraphError.md#context)
