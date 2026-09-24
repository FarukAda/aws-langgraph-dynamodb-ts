[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / S3OffloadConfig

# Interface: S3OffloadConfig

Defined in: [shared/codec/s3/config.ts:26](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/codec/s3/config.ts#L26)

Configuration for offloading large payloads to S3.

## Properties

### bucketName

> **bucketName**: `string`

Defined in: [shared/codec/s3/config.ts:27](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/codec/s3/config.ts#L27)

***

### clientConfig?

> `optional` **clientConfig?**: [`S3ClientConfigLike`](../type-aliases/S3ClientConfigLike.md)

Defined in: [shared/codec/s3/config.ts:46](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/codec/s3/config.ts#L46)

S3 client configuration (an `S3ClientConfig`). `region` defaults to the
adapter's DynamoDB region.

***

### keyPrefix?

> `optional` **keyPrefix?**: `string`

Defined in: [shared/codec/s3/config.ts:28](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/codec/s3/config.ts#L28)

***

### maxDownloadBytes?

> `optional` **maxDownloadBytes?**: `number`

Defined in: [shared/codec/s3/config.ts:41](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/codec/s3/config.ts#L41)

Largest object this adapter will buffer from S3 (default 50 MiB).

***

### serverSideEncryption?

> `optional` **serverSideEncryption?**: `string`

Defined in: [shared/codec/s3/config.ts:38](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/codec/s3/config.ts#L38)

***

### sseKmsKeyId?

> `optional` **sseKmsKeyId?**: `string`

Defined in: [shared/codec/s3/config.ts:39](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/codec/s3/config.ts#L39)

***

### thresholdBytes?

> `optional` **thresholdBytes?**: `number`

Defined in: [shared/codec/s3/config.ts:37](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/codec/s3/config.ts#L37)

Serialized payloads at or above this size are offloaded (default 350 KB).
Only the payload counts: the store's inline embedding (about 10 bytes per
dimension, so ~10 KB at 1024 dims and ~45 KB at 4096) lives on the same
item and is not part of it, so keep `thresholdBytes` plus the embedding
under DynamoDB's 400 KB item limit or the put fails with a raw
`ValidationException`.
