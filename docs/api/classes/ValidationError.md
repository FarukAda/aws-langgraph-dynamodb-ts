[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / ValidationError

# Class: ValidationError

Defined in: [shared/errors/errors.ts:7](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/errors/errors.ts#L7)

Input failed a validation rule before any AWS call was made; `context.field` names the input.

## Extends

- [`DynamoDBLangGraphError`](DynamoDBLangGraphError.md)

## Constructors

### Constructor

> **new ValidationError**(`message`, `field?`, `cause?`): `ValidationError`

Defined in: [shared/errors/errors.ts:8](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/errors/errors.ts#L8)

#### Parameters

##### message

`string`

##### field?

`string`

##### cause?

`Error`

#### Returns

`ValidationError`

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
