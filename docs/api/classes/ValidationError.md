[**AWS LangGraph DynamoDB TypeScript v0.9.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / ValidationError

# Class: ValidationError

Defined in: [shared/errors/errors.ts:6](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/c3f018f37290d04fc34b7157d4ff279f0567c7f1/src/shared/errors/errors.ts#L6)

Input failed a validation rule before any AWS call was made.

## Extends

- [`DynamoDbLangGraphError`](DynamoDbLangGraphError.md)

## Constructors

### Constructor

> **new ValidationError**(`message`, `field?`): `ValidationError`

Defined in: [shared/errors/errors.ts:7](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/c3f018f37290d04fc34b7157d4ff279f0567c7f1/src/shared/errors/errors.ts#L7)

#### Parameters

##### message

`string`

##### field?

`string`

#### Returns

`ValidationError`

#### Overrides

[`DynamoDbLangGraphError`](DynamoDbLangGraphError.md).[`constructor`](DynamoDbLangGraphError.md#constructor)

## Properties

### code

> `readonly` **code**: [`ErrorCode`](../enumerations/ErrorCode.md)

Defined in: [shared/errors/base-error.ts:20](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/c3f018f37290d04fc34b7157d4ff279f0567c7f1/src/shared/errors/base-error.ts#L20)

#### Inherited from

[`DynamoDbLangGraphError`](DynamoDbLangGraphError.md).[`code`](DynamoDbLangGraphError.md#code)

***

### context

> `readonly` **context**: [`ErrorContext`](../interfaces/ErrorContext.md)

Defined in: [shared/errors/base-error.ts:21](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/c3f018f37290d04fc34b7157d4ff279f0567c7f1/src/shared/errors/base-error.ts#L21)

#### Inherited from

[`DynamoDbLangGraphError`](DynamoDbLangGraphError.md).[`context`](DynamoDbLangGraphError.md#context)
