[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / UpstreamError

# Class: UpstreamError

Defined in: [shared/errors/upstream-error.ts:19](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/upstream-error.ts#L19)

A failure that originated below this library — the AWS SDK, the transport,
a third-party `VectorBackend` or `Embeddings` — and surfaced through one of
its public methods. Wrapping it keeps the promise that every rejection a
caller sees is a [DynamoDBLangGraphError](DynamoDBLangGraphError.md) with a branchable `code`,
while losing nothing a support ticket needs: the SDK's own error name, the
request id and HTTP status when present, and the original as `cause`.

## Extends

- [`DynamoDBLangGraphError`](DynamoDBLangGraphError.md)

## Constructors

### Constructor

> **new UpstreamError**(`cause`, `operation`): `UpstreamError`

Defined in: [shared/errors/upstream-error.ts:37](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/upstream-error.ts#L37)

Accepts: `cause` — the failure from below: the AWS SDK, the transport, a
third-party `VectorBackend` or `Embeddings`. `operation` — the public
method it surfaced through.

Returns: the error, with `code: UPSTREAM`, the SDK's own error name as
`upstreamName`, and the request id and HTTP status when the SDK supplied
them. Absent metadata leaves no `undefined`-valued own property behind, so
a serialized error carries only what is real.

Throws: nothing; building an error may not fail.

#### Parameters

##### cause

`Error`

##### operation

`string`

#### Returns

`UpstreamError`

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

***

### httpStatusCode?

> `readonly` `optional` **httpStatusCode?**: `number`

Defined in: [shared/errors/upstream-error.ts:23](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/upstream-error.ts#L23)

***

### requestId?

> `readonly` `optional` **requestId?**: `string`

Defined in: [shared/errors/upstream-error.ts:22](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/upstream-error.ts#L22)

Declared, not emitted: absent metadata leaves no `undefined`-valued own property behind.

***

### upstreamName

> `readonly` **upstreamName**: `string`

Defined in: [shared/errors/upstream-error.ts:20](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/upstream-error.ts#L20)
