[**AWS LangGraph DynamoDB TypeScript v0.8.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / FactoryBaseOptions

# Interface: FactoryBaseOptions

Defined in: [factory/factory.ts:14](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/b9d505b52648c7e723f3e953aac58e9fe52a329f/src/factory/factory.ts#L14)

Shared client/logger defaults applied to every adapter the factory builds.

## Properties

### client?

> `optional` **client?**: `DynamoDBDocument`

Defined in: [factory/factory.ts:15](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/b9d505b52648c7e723f3e953aac58e9fe52a329f/src/factory/factory.ts#L15)

***

### clientConfig?

> `optional` **clientConfig?**: `DynamoDBClientConfig`

Defined in: [factory/factory.ts:16](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/b9d505b52648c7e723f3e953aac58e9fe52a329f/src/factory/factory.ts#L16)

***

### createClient?

> `optional` **createClient?**: (`config`) => `DynamoDBClient`

Defined in: [factory/factory.ts:17](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/b9d505b52648c7e723f3e953aac58e9fe52a329f/src/factory/factory.ts#L17)

#### Parameters

##### config

`DynamoDBClientConfig`

#### Returns

`DynamoDBClient`

***

### logger?

> `optional` **logger?**: [`Logger`](Logger.md)

Defined in: [factory/factory.ts:18](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/b9d505b52648c7e723f3e953aac58e9fe52a329f/src/factory/factory.ts#L18)
