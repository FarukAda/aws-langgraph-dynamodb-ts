[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / Logger

# Interface: Logger

Defined in: [shared/logging/logger.ts:10](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/logging/logger.ts#L10)

Pluggable logging interface — consumers supply their own implementation.
`args` are structured fields, at most one plain object per call, so an
adapter for a structured logger (pino, winston) can merge them into one
record; the message is a fixed string and never carries a value.

## Methods

### debug()

> **debug**(`message`, ...`args`): `void`

Defined in: [shared/logging/logger.ts:14](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/logging/logger.ts#L14)

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

Defined in: [shared/logging/logger.ts:13](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/logging/logger.ts#L13)

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

Defined in: [shared/logging/logger.ts:11](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/logging/logger.ts#L11)

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

Defined in: [shared/logging/logger.ts:12](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/logging/logger.ts#L12)

#### Parameters

##### message

`string`

##### args

...[`LogArgument`](../type-aliases/LogArgument.md)[]

#### Returns

`void`
