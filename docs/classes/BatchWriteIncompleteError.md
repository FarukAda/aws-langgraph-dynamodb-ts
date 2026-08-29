[**AWS LangGraph DynamoDB TypeScript v0.8.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BatchWriteIncompleteError

# Class: BatchWriteIncompleteError

Defined in: [shared/errors/errors.ts:61](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/shared/errors/errors.ts#L61)

A BatchWriteItem sequence could not drain its UnprocessedItems. Items NOT
listed in [unprocessed](#unprocessed) were acked by DynamoDB and persist — there is
no rollback (drive reconciliation from `unprocessed`). `cause`, when given,
is the underlying failure that interrupted the drain (e.g. a thrown,
non-UnprocessedItems error from a retry round) rather than a clean exhaustion
of the UnprocessedItems retry budget.

## Extends

- [`DynamoDbLangGraphError`](DynamoDbLangGraphError.md)

## Constructors

### Constructor

> **new BatchWriteIncompleteError**(`succeededCount`, `unprocessed`, `retries`, `cause?`): `BatchWriteIncompleteError`

Defined in: [shared/errors/errors.ts:65](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/shared/errors/errors.ts#L65)

#### Parameters

##### succeededCount

`number`

##### unprocessed

`WriteRequest`[]

##### retries

`number`

##### cause?

`Error`

#### Returns

`BatchWriteIncompleteError`

#### Overrides

[`DynamoDbLangGraphError`](DynamoDbLangGraphError.md).[`constructor`](DynamoDbLangGraphError.md#constructor)

## Properties

### code

> `readonly` **code**: [`ErrorCode`](../enumerations/ErrorCode.md)

Defined in: [shared/errors/base-error.ts:20](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/shared/errors/base-error.ts#L20)

#### Inherited from

[`DynamoDbLangGraphError`](DynamoDbLangGraphError.md).[`code`](DynamoDbLangGraphError.md#code)

***

### context

> `readonly` **context**: [`ErrorContext`](../interfaces/ErrorContext.md)

Defined in: [shared/errors/base-error.ts:21](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/shared/errors/base-error.ts#L21)

#### Inherited from

[`DynamoDbLangGraphError`](DynamoDbLangGraphError.md).[`context`](DynamoDbLangGraphError.md#context)

***

### succeededCount

> `readonly` **succeededCount**: `number`

Defined in: [shared/errors/errors.ts:62](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/shared/errors/errors.ts#L62)

***

### unprocessed

> `readonly` **unprocessed**: `WriteRequest`[]

Defined in: [shared/errors/errors.ts:63](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/shared/errors/errors.ts#L63)
