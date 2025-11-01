[**AWS LangGraph DynamoDB TypeScript v0.0.9**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBSaverOptions

# Interface: DynamoDBSaverOptions

Defined in: [checkpointer/types/index.ts:20](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/checkpointer/types/index.ts#L20)

Configuration options for DynamoDBSaver

## Properties

### checkpointsTableName

> **checkpointsTableName**: `string`

Defined in: [checkpointer/types/index.ts:21](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/checkpointer/types/index.ts#L21)

Name of the DynamoDB table for storing checkpoints

***

### clientConfig?

> `optional` **clientConfig**: `DynamoDBClientConfig`

Defined in: [checkpointer/types/index.ts:25](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/checkpointer/types/index.ts#L25)

Optional DynamoDB client configuration

***

### serde?

> `optional` **serde**: `SerializerProtocol`

Defined in: [checkpointer/types/index.ts:24](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/checkpointer/types/index.ts#L24)

Optional custom serializer protocol for checkpoint serialization

***

### ttlDays?

> `optional` **ttlDays**: `number`

Defined in: [checkpointer/types/index.ts:23](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/checkpointer/types/index.ts#L23)

Optional TTL in days for automatic item expiration (max 1825 days)

***

### writesTableName

> **writesTableName**: `string`

Defined in: [checkpointer/types/index.ts:22](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/checkpointer/types/index.ts#L22)

Name of the DynamoDB table for storing pending writes
