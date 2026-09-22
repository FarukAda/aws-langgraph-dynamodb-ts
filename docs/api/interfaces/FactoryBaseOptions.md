[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / FactoryBaseOptions

# Interface: FactoryBaseOptions

Defined in: [factory/types.ts:21](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L21)

Defaults applied to every adapter the factory builds: the client (or how to
build one) and the cross-cutting options a team usually wants identical
across its checkpointer, store and history. A per-adapter option wins.

## Properties

### client?

> `optional` **client?**: [`DynamoDBDocumentLike`](../type-aliases/DynamoDBDocumentLike.md)

Defined in: [factory/types.ts:27](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L27)

Reused as-is by every adapter. Construct it with `maxAttempts: 1`, or the
SDK's own retries stack inside the library's retry budget (each adapter
logs a `warn` at construction when they would).

***

### clientConfig?

> `optional` **clientConfig?**: `DynamoDBClientConfig`

Defined in: [factory/types.ts:33](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L33)

Used to build the client, and read for its `region` when an `s3` config
names none — including by `createAll`, whose adapters are handed the shared
client rather than this config.

***

### compression?

> `optional` **compression?**: [`CompressionConfig`](CompressionConfig.md)

Defined in: [factory/types.ts:42](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L42)

***

### logger?

> `optional` **logger?**: [`Logger`](Logger.md)

Defined in: [factory/types.ts:40](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L40)

***

### retry?

> `optional` **retry?**: [`RetryPolicy`](RetryPolicy.md)

Defined in: [factory/types.ts:44](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L44)

***

### s3?

> `optional` **s3?**: [`S3OffloadConfig`](S3OffloadConfig.md)

Defined in: [factory/types.ts:43](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L43)

***

### ttl?

> `optional` **ttl?**: [`TtlOption`](../type-aliases/TtlOption.md)

Defined in: [factory/types.ts:41](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L41)
