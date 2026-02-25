[**AWS LangGraph DynamoDB TypeScript v0.1.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBSaverOptions

# Interface: DynamoDBSaverOptions

Defined in: [checkpointer/types/index.ts:22](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/checkpointer/types/index.ts#L22)

Configuration options for DynamoDBSaver

## Properties

### checkpointsTableName

> **checkpointsTableName**: `string`

Defined in: [checkpointer/types/index.ts:23](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/checkpointer/types/index.ts#L23)

Name of the DynamoDB table for storing checkpoints

***

### client?

> `optional` **client**: `DynamoDBDocument`

Defined in: [checkpointer/types/index.ts:35](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/checkpointer/types/index.ts#L35)

Optional pre-built DynamoDBDocument client (takes precedence over clientConfig)

***

### clientConfig?

> `optional` **clientConfig**: `DynamoDBClientConfig`

Defined in: [checkpointer/types/index.ts:33](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/checkpointer/types/index.ts#L33)

Optional DynamoDB client configuration

***

### compression?

> `optional` **compression**: `CompressionConfig`

Defined in: [checkpointer/types/index.ts:29](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/checkpointer/types/index.ts#L29)

Optional compression configuration for checkpoint data

***

### s3OffloadConfig?

> `optional` **s3OffloadConfig**: `S3OffloadConfig`

Defined in: [checkpointer/types/index.ts:31](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/checkpointer/types/index.ts#L31)

Optional S3 offloading for payloads exceeding DynamoDB's 400KB item limit

***

### serde?

> `optional` **serde**: `SerializerProtocol`

Defined in: [checkpointer/types/index.ts:32](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/checkpointer/types/index.ts#L32)

Optional custom serializer protocol for checkpoint serialization

***

### ttlDays?

> `optional` **ttlDays**: `number`

Defined in: [checkpointer/types/index.ts:25](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/checkpointer/types/index.ts#L25)

Optional TTL in days for automatic item expiration (max 1825 days)

***

### ttlSeconds?

> `optional` **ttlSeconds**: `number`

Defined in: [checkpointer/types/index.ts:27](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/checkpointer/types/index.ts#L27)

TTL in seconds for automatic item expiration (overrides ttlDays if both set)

***

### writesTableName

> **writesTableName**: `string`

Defined in: [checkpointer/types/index.ts:24](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/9e71a27abaf2b0da566fa8a6f0702254a1cd0356/src/checkpointer/types/index.ts#L24)

Name of the DynamoDB table for storing pending writes
