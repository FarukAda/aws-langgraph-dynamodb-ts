[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / S3OffloadConfig

# Interface: S3OffloadConfig

Defined in: [shared/codec/s3/config.ts:7](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/codec/s3/config.ts#L7)

Configuration for offloading large payloads to S3.

## Properties

### bucketName

> **bucketName**: `string`

Defined in: [shared/codec/s3/config.ts:8](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/codec/s3/config.ts#L8)

***

### clientConfig?

> `optional` **clientConfig?**: [`S3ClientConfigLike`](../type-aliases/S3ClientConfigLike.md)

Defined in: [shared/codec/s3/config.ts:27](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/codec/s3/config.ts#L27)

S3 client configuration (an `S3ClientConfig`). `region` defaults to the
adapter's DynamoDB region.

***

### keyPrefix?

> `optional` **keyPrefix?**: `string`

Defined in: [shared/codec/s3/config.ts:9](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/codec/s3/config.ts#L9)

***

### maxDownloadBytes?

> `optional` **maxDownloadBytes?**: `number`

Defined in: [shared/codec/s3/config.ts:22](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/codec/s3/config.ts#L22)

Largest object this adapter will buffer from S3 (default 50 MiB).

***

### serverSideEncryption?

> `optional` **serverSideEncryption?**: `string`

Defined in: [shared/codec/s3/config.ts:19](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/codec/s3/config.ts#L19)

***

### sseKmsKeyId?

> `optional` **sseKmsKeyId?**: `string`

Defined in: [shared/codec/s3/config.ts:20](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/codec/s3/config.ts#L20)

***

### thresholdBytes?

> `optional` **thresholdBytes?**: `number`

Defined in: [shared/codec/s3/config.ts:18](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/codec/s3/config.ts#L18)

Serialized payloads at or above this size are offloaded (default 350 KB).
Only the payload counts: the store's inline embedding (about 10 bytes per
dimension, so ~10 KB at 1024 dims and ~45 KB at 4096) lives on the same
item and is not part of it, so keep `thresholdBytes` plus the embedding
under DynamoDB's 400 KB item limit or the put fails with a raw
`ValidationException`.
