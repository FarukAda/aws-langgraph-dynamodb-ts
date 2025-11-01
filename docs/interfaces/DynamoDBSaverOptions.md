[**AWS LangGraph DynamoDB TypeScript v0.0.7**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBSaverOptions

# Interface: DynamoDBSaverOptions

Defined in: [checkpointer/types/index.ts:20](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/checkpointer/types/index.ts#L20)

Configuration options for DynamoDBSaver

## Properties

### checkpointsTableName

> **checkpointsTableName**: `string`

Defined in: [checkpointer/types/index.ts:21](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/checkpointer/types/index.ts#L21)

Name of the DynamoDB table for storing checkpoints

***

### clientConfig?

> `optional` **clientConfig**: `DynamoDBClientConfig`

Defined in: [checkpointer/types/index.ts:25](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/checkpointer/types/index.ts#L25)

Optional DynamoDB client configuration

***

### serde?

> `optional` **serde**: `SerializerProtocol`

Defined in: [checkpointer/types/index.ts:24](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/checkpointer/types/index.ts#L24)

Optional custom serializer protocol for checkpoint serialization

***

### ttlDays?

> `optional` **ttlDays**: `number`

Defined in: [checkpointer/types/index.ts:23](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/checkpointer/types/index.ts#L23)

Optional TTL in days for automatic item expiration (max 1825 days)

***

### writesTableName

> **writesTableName**: `string`

Defined in: [checkpointer/types/index.ts:22](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/2063c8662e43fe7414f92d4d22aec4daf96d6417/src/checkpointer/types/index.ts#L22)

Name of the DynamoDB table for storing pending writes
