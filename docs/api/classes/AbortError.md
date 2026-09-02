[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / AbortError

# Class: AbortError

Defined in: [shared/errors/errors.ts:48](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L48)

An operation was cancelled via its AbortSignal.

## Extends

- [`DynamoDBLangGraphError`](DynamoDBLangGraphError.md)

## Constructors

### Constructor

> **new AbortError**(`message?`, `cause?`): `AbortError`

Defined in: [shared/errors/errors.ts:49](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L49)

#### Parameters

##### message?

`string` = `'Operation aborted'`

##### cause?

`Error`

#### Returns

`AbortError`

#### Overrides

[`DynamoDBLangGraphError`](DynamoDBLangGraphError.md).[`constructor`](DynamoDBLangGraphError.md#constructor)

## Properties

### code

> `readonly` **code**: [`ErrorCode`](../enumerations/ErrorCode.md)

Defined in: [shared/errors/base-error.ts:29](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L29)

#### Inherited from

[`DynamoDBLangGraphError`](DynamoDBLangGraphError.md).[`code`](DynamoDBLangGraphError.md#code)

***

### context

> `readonly` **context**: [`ErrorContext`](../interfaces/ErrorContext.md)

Defined in: [shared/errors/base-error.ts:30](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L30)

#### Inherited from

[`DynamoDBLangGraphError`](DynamoDBLangGraphError.md).[`context`](DynamoDBLangGraphError.md#context)
