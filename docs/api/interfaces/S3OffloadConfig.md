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

Defined in: [shared/codec/s3/config.ts:52](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/codec/s3/config.ts#L52)

S3 client configuration (an `S3ClientConfig`). `region` defaults to the
adapter's DynamoDB region.

***

### keyPrefix?

> `optional` **keyPrefix?**: `string`

Defined in: [shared/codec/s3/config.ts:28](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/codec/s3/config.ts#L28)

***

### maxDownloadBytes?

> `optional` **maxDownloadBytes?**: `number`

Defined in: [shared/codec/s3/config.ts:47](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/codec/s3/config.ts#L47)

Largest object this adapter will buffer from S3 (default 50 MiB). An
offloaded payload larger than it is refused at the write, and a value
below `thresholdBytes` is refused at construction, so an adapter never
stores an object it could not read back.

***

### serverSideEncryption?

> `optional` **serverSideEncryption?**: `string`

Defined in: [shared/codec/s3/config.ts:39](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/codec/s3/config.ts#L39)

***

### sseKmsKeyId?

> `optional` **sseKmsKeyId?**: `string`

Defined in: [shared/codec/s3/config.ts:40](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/codec/s3/config.ts#L40)

***

### thresholdBytes?

> `optional` **thresholdBytes?**: `number`

Defined in: [shared/codec/s3/config.ts:38](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/codec/s3/config.ts#L38)

Serialized payloads at or above this size are offloaded (default 350 KB).
Only the payload counts: the store's inline vectors live on the same item
and are not part of it. The store embeds one vector per text its
`index.fields` extract — a wildcard path yields one per element — each up
to about 10 bytes per dimension, so three texts at 1024 dims cost roughly
30 KB. A row that payload and those vectors would take past DynamoDB's
400 KB item limit is refused with `VALIDATION` naming `index`.
