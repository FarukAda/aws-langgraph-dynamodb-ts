[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / Logger

# Interface: Logger

Defined in: [shared/logging/logger.ts:25](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/logging/logger.ts#L25)

Pluggable logging interface — consumers supply their own implementation.
`args` are structured fields, at most one plain object per call, so an
adapter for a structured logger (pino, winston) can merge them into one
record; the message is a fixed string and never carries a value.

It is the one piece of foreign code every adapter of this package calls,
almost always from a `catch` block, so an adapter wraps it: anything one of
its methods throws is absorbed at the log call and never replaces the error
being reported.

## Methods

### debug()

> **debug**(`message`, ...`args`): `void`

Defined in: [shared/logging/logger.ts:29](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/logging/logger.ts#L29)

#### Parameters

##### message

`string`

##### args

...[`LogArgument`](../type-aliases/LogArgument.md)[]

#### Returns

`void`

***

### error()

> **error**(`message`, ...`args`): `void`

Defined in: [shared/logging/logger.ts:28](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/logging/logger.ts#L28)

#### Parameters

##### message

`string`

##### args

...[`LogArgument`](../type-aliases/LogArgument.md)[]

#### Returns

`void`

***

### info()

> **info**(`message`, ...`args`): `void`

Defined in: [shared/logging/logger.ts:26](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/logging/logger.ts#L26)

#### Parameters

##### message

`string`

##### args

...[`LogArgument`](../type-aliases/LogArgument.md)[]

#### Returns

`void`

***

### warn()

> **warn**(`message`, ...`args`): `void`

Defined in: [shared/logging/logger.ts:27](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/logging/logger.ts#L27)

#### Parameters

##### message

`string`

##### args

...[`LogArgument`](../type-aliases/LogArgument.md)[]

#### Returns

`void`
