[**AWS LangGraph DynamoDB TypeScript v0.0.9**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBStoreOptions

# Interface: DynamoDBStoreOptions

Defined in: [store/types/index.ts:19](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/store/types/index.ts#L19)

Configuration options for DynamoDBStore

## Properties

### clientConfig?

> `optional` **clientConfig**: `DynamoDBClientConfig`

Defined in: [store/types/index.ts:25](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/store/types/index.ts#L25)

Optional DynamoDB client configuration

***

### embedding?

> `optional` **embedding**: `BedrockEmbeddings`

Defined in: [store/types/index.ts:23](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/store/types/index.ts#L23)

Optional Bedrock embeddings for semantic search

***

### memoryTableName

> **memoryTableName**: `string`

Defined in: [store/types/index.ts:21](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/store/types/index.ts#L21)

Name of the DynamoDB table to use for storage

***

### ttlDays?

> `optional` **ttlDays**: `number`

Defined in: [store/types/index.ts:27](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/aa020601b05dff0f72f65954c786d026ab47f57b/src/store/types/index.ts#L27)

Optional TTL in days for stored items (1-1825 days)
