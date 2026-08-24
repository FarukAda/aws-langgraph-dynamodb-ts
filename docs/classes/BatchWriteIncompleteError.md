[**AWS LangGraph DynamoDB TypeScript v0.3.1**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BatchWriteIncompleteError

# Class: BatchWriteIncompleteError

Defined in: [shared/errors/errors.ts:58](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/shared/errors/errors.ts#L58)

A BatchWriteItem sequence could not drain its UnprocessedItems. Items NOT
listed in [unprocessed](#unprocessed) were acked by DynamoDB and persist — there is
no rollback (drive reconciliation from `unprocessed`).

## Extends

- [`DynamoDbLangGraphError`](DynamoDbLangGraphError.md)

## Constructors

### Constructor

> **new BatchWriteIncompleteError**(`succeededCount`, `unprocessed`, `retries`): `BatchWriteIncompleteError`

Defined in: [shared/errors/errors.ts:62](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/shared/errors/errors.ts#L62)

#### Parameters

##### succeededCount

`number`

##### unprocessed

`WriteRequest`[]

##### retries

`number`

#### Returns

`BatchWriteIncompleteError`

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

***

### succeededCount

> `readonly` **succeededCount**: `number`

Defined in: [shared/errors/errors.ts:59](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/shared/errors/errors.ts#L59)

***

### unprocessed

> `readonly` **unprocessed**: `WriteRequest`[]

Defined in: [shared/errors/errors.ts:60](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/shared/errors/errors.ts#L60)
