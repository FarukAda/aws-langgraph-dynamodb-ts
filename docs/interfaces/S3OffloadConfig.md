[**AWS LangGraph DynamoDB TypeScript v0.9.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / S3OffloadConfig

# Interface: S3OffloadConfig

Defined in: shared/codec/s3/config.ts:4

Configuration for offloading large payloads to S3.

## Properties

### bucketName

> **bucketName**: `string`

Defined in: shared/codec/s3/config.ts:5

***

### clientConfig?

> `optional` **clientConfig?**: `S3ClientConfig`

Defined in: shared/codec/s3/config.ts:10

***

### createS3Client?

> `optional` **createS3Client?**: (`config`) => `S3Client`

Defined in: shared/codec/s3/config.ts:11

#### Parameters

##### config

`S3ClientConfig`

#### Returns

`S3Client`

***

### keyPrefix?

> `optional` **keyPrefix?**: `string`

Defined in: shared/codec/s3/config.ts:6

***

### serverSideEncryption?

> `optional` **serverSideEncryption?**: `string`

Defined in: shared/codec/s3/config.ts:8

***

### sseKmsKeyId?

> `optional` **sseKmsKeyId?**: `string`

Defined in: shared/codec/s3/config.ts:9

***

### thresholdBytes?

> `optional` **thresholdBytes?**: `number`

Defined in: shared/codec/s3/config.ts:7
