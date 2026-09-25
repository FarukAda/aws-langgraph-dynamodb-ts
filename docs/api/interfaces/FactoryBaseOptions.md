[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / FactoryBaseOptions

# Interface: FactoryBaseOptions

Defined in: [factory/types.ts:30](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L30)

Defaults applied to every adapter the factory builds: the client (or how to
build one) and the cross-cutting options a team usually wants identical
across its checkpointer, store and history. A per-adapter option wins.

## Properties

### client?

> `optional` **client?**: [`DynamoDBDocumentLike`](../type-aliases/DynamoDBDocumentLike.md)

Defined in: [factory/types.ts:36](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L36)

Reused as-is by every adapter. Construct it with `maxAttempts: 1`, or the
SDK's own retries stack inside the library's retry budget (each adapter
logs a `warn` at construction when they would).

***

### clientConfig?

> `optional` **clientConfig?**: `DynamoDBClientConfig`

Defined in: [factory/types.ts:42](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L42)

The config the client is built from, and read for its `region` when an `s3`
config names none — including by `createAll`, whose adapters are handed the
shared client rather than this config.

***

### compression?

> `optional` **compression?**: [`CompressionConfig`](CompressionConfig.md)

Defined in: [factory/types.ts:51](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L51)

***

### logger?

> `optional` **logger?**: [`Logger`](Logger.md)

Defined in: [factory/types.ts:49](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L49)

***

### retry?

> `optional` **retry?**: [`RetryPolicy`](RetryPolicy.md)

Defined in: [factory/types.ts:53](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L53)

***

### s3?

> `optional` **s3?**: [`S3OffloadConfig`](S3OffloadConfig.md)

Defined in: [factory/types.ts:52](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L52)

***

### ttl?

> `optional` **ttl?**: [`TtlOption`](../type-aliases/TtlOption.md)

Defined in: [factory/types.ts:50](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L50)
