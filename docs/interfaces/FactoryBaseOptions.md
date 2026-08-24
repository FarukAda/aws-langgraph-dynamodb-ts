[**AWS LangGraph DynamoDB TypeScript v0.3.1**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / FactoryBaseOptions

# Interface: FactoryBaseOptions

Defined in: [factory/factory.ts:13](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/factory/factory.ts#L13)

Shared client/logger defaults applied to every adapter the factory builds.

## Properties

### clientConfig?

> `optional` **clientConfig?**: `DynamoDBClientConfig`

Defined in: [factory/factory.ts:14](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/factory/factory.ts#L14)

***

### createClient?

> `optional` **createClient?**: (`config`) => `DynamoDBClient`

Defined in: [factory/factory.ts:15](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/factory/factory.ts#L15)

#### Parameters

##### config

`DynamoDBClientConfig`

#### Returns

`DynamoDBClient`

***

### logger?

> `optional` **logger?**: [`Logger`](Logger.md)

Defined in: [factory/factory.ts:16](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/factory/factory.ts#L16)
