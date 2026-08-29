[**AWS LangGraph DynamoDB TypeScript v0.9.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BaseAdapterOptions

# Interface: BaseAdapterOptions

Defined in: shared/options.ts:13

Options common to every adapter (the unified options shape). An adapter
either reuses an injected `client` or builds one from `clientConfig`.

## Properties

### client?

> `optional` **client?**: `DynamoDBDocument`

Defined in: shared/options.ts:17

Pre-built DocumentClient to reuse; when set, the adapter does not own it.

***

### clientConfig?

> `optional` **clientConfig?**: `DynamoDBClientConfig`

Defined in: shared/options.ts:19

Config used to build a client when `client` is not provided.

***

### createClient?

> `optional` **createClient?**: (`config`) => `DynamoDBClient`

Defined in: shared/options.ts:21

Factory seam for constructing the underlying client (testing).

#### Parameters

##### config

`DynamoDBClientConfig`

#### Returns

`DynamoDBClient`

***

### logger?

> `optional` **logger?**: [`Logger`](Logger.md)

Defined in: shared/options.ts:25

Optional per-instance logger (defaults to a silent logger).

***

### tableName

> **tableName**: `string`

Defined in: shared/options.ts:15

DynamoDB table name.

***

### ttl?

> `optional` **ttl?**: [`TtlOption`](../type-aliases/TtlOption.md)

Defined in: shared/options.ts:23

Optional time-to-live applied to written items.
