[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / ValidationError

# Class: ValidationError

Defined in: [shared/errors/errors.ts:8](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L8)

Input failed a validation rule before any AWS call was made; `context.field` names the input.

## Extends

- [`DynamoDBLangGraphError`](DynamoDBLangGraphError.md)

## Constructors

### Constructor

> **new ValidationError**(`message`, `field?`, `cause?`): `ValidationError`

Defined in: [shared/errors/errors.ts:20](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/errors.ts#L20)

Accepts: `field` — the option, argument or cap that failed, dotted for a
nested one (`s3.bucketName`). Omitted only where no single input is at
fault.

Returns: the error, with `code: VALIDATION` and `context.field` set when a
field was named — which is what a caller branches on to point at the
offending input.

Throws: nothing; building an error may not fail.

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

Defined in: [shared/errors/base-error.ts:33](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L33)

#### Inherited from

[`DynamoDBLangGraphError`](DynamoDBLangGraphError.md).[`code`](DynamoDBLangGraphError.md#code)

***

### context

> `readonly` **context**: [`ErrorContext`](../interfaces/ErrorContext.md)

Defined in: [shared/errors/base-error.ts:34](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L34)

#### Inherited from

[`DynamoDBLangGraphError`](DynamoDBLangGraphError.md).[`context`](DynamoDBLangGraphError.md#context)
