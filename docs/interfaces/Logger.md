[**AWS LangGraph DynamoDB TypeScript v0.8.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / Logger

# Interface: Logger

Defined in: [shared/logging/logger.ts:5](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/b9d505b52648c7e723f3e953aac58e9fe52a329f/src/shared/logging/logger.ts#L5)

Pluggable logging interface — consumers supply their own implementation.

## Methods

### debug()

> **debug**(`message`, ...`args`): `void`

Defined in: [shared/logging/logger.ts:9](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/b9d505b52648c7e723f3e953aac58e9fe52a329f/src/shared/logging/logger.ts#L9)

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

Defined in: [shared/logging/logger.ts:8](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/b9d505b52648c7e723f3e953aac58e9fe52a329f/src/shared/logging/logger.ts#L8)

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

Defined in: [shared/logging/logger.ts:6](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/b9d505b52648c7e723f3e953aac58e9fe52a329f/src/shared/logging/logger.ts#L6)

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

Defined in: [shared/logging/logger.ts:7](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/b9d505b52648c7e723f3e953aac58e9fe52a329f/src/shared/logging/logger.ts#L7)

#### Parameters

##### message

`string`

##### args

...[`LogArgument`](../type-aliases/LogArgument.md)[]

#### Returns

`void`
