[**AWS LangGraph DynamoDB TypeScript v0.9.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / FactoryBaseOptions

# Interface: FactoryBaseOptions

Defined in: factory/factory.ts:14

Shared client/logger defaults applied to every adapter the factory builds.

## Properties

### client?

> `optional` **client?**: `DynamoDBDocument`

Defined in: factory/factory.ts:15

***

### clientConfig?

> `optional` **clientConfig?**: `DynamoDBClientConfig`

Defined in: factory/factory.ts:16

***

### createClient?

> `optional` **createClient?**: (`config`) => `DynamoDBClient`

Defined in: factory/factory.ts:17

#### Parameters

##### config

`DynamoDBClientConfig`

#### Returns

`DynamoDBClient`

***

### logger?

> `optional` **logger?**: [`Logger`](Logger.md)

Defined in: factory/factory.ts:18
