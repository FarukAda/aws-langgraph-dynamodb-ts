[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BaseAdapterOptions

# Interface: BaseAdapterOptions

Defined in: [shared/options.ts:14](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/options.ts#L14)

Options common to every adapter (the unified options shape). An adapter
either reuses an injected `client` or builds one from `clientConfig`.

## Properties

### client?

> `optional` **client?**: `DynamoDBDocument`

Defined in: [shared/options.ts:18](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/options.ts#L18)

Pre-built DocumentClient to reuse; when set, the adapter does not own it.

***

### clientConfig?

> `optional` **clientConfig?**: `DynamoDBClientConfig`

Defined in: [shared/options.ts:20](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/options.ts#L20)

Config used to build a client when `client` is not provided.

***

### logger?

> `optional` **logger?**: [`Logger`](Logger.md)

Defined in: [shared/options.ts:30](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/options.ts#L30)

Optional per-instance logger (defaults to a silent logger).

***

### retry?

> `optional` **retry?**: [`RetryPolicy`](RetryPolicy.md)

Defined in: [shared/options.ts:32](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/options.ts#L32)

Retry budget and backoff for every DynamoDB call (see the README "Retries and backoff").

***

### tableName

> **tableName**: `string`

Defined in: [shared/options.ts:16](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/options.ts#L16)

DynamoDB table name.

***

### ttl?

> `optional` **ttl?**: [`TtlOption`](../type-aliases/TtlOption.md)

Defined in: [shared/options.ts:28](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/options.ts#L28)

Optional time-to-live applied to written items.
