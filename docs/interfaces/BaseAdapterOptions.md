[**AWS LangGraph DynamoDB TypeScript v0.8.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BaseAdapterOptions

# Interface: BaseAdapterOptions

Defined in: [shared/options.ts:13](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/shared/options.ts#L13)

Options common to every adapter (the unified options shape). An adapter
either reuses an injected `client` or builds one from `clientConfig`.

## Properties

### client?

> `optional` **client?**: `DynamoDBDocument`

Defined in: [shared/options.ts:17](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/shared/options.ts#L17)

Pre-built DocumentClient to reuse; when set, the adapter does not own it.

***

### clientConfig?

> `optional` **clientConfig?**: `DynamoDBClientConfig`

Defined in: [shared/options.ts:19](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/shared/options.ts#L19)

Config used to build a client when `client` is not provided.

***

### createClient?

> `optional` **createClient?**: (`config`) => `DynamoDBClient`

Defined in: [shared/options.ts:21](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/shared/options.ts#L21)

Factory seam for constructing the underlying client (testing).

#### Parameters

##### config

`DynamoDBClientConfig`

#### Returns

`DynamoDBClient`

***

### logger?

> `optional` **logger?**: [`Logger`](Logger.md)

Defined in: [shared/options.ts:25](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/shared/options.ts#L25)

Optional per-instance logger (defaults to a silent logger).

***

### tableName

> **tableName**: `string`

Defined in: [shared/options.ts:15](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/shared/options.ts#L15)

DynamoDB table name.

***

### ttl?

> `optional` **ttl?**: [`TtlOption`](../type-aliases/TtlOption.md)

Defined in: [shared/options.ts:23](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/shared/options.ts#L23)

Optional time-to-live applied to written items.
