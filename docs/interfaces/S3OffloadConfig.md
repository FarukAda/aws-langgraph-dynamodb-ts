[**AWS LangGraph DynamoDB TypeScript v0.8.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / S3OffloadConfig

# Interface: S3OffloadConfig

Defined in: [shared/codec/s3/config.ts:4](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/b9d505b52648c7e723f3e953aac58e9fe52a329f/src/shared/codec/s3/config.ts#L4)

Configuration for offloading large payloads to S3.

## Properties

### bucketName

> **bucketName**: `string`

Defined in: [shared/codec/s3/config.ts:5](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/b9d505b52648c7e723f3e953aac58e9fe52a329f/src/shared/codec/s3/config.ts#L5)

***

### clientConfig?

> `optional` **clientConfig?**: `S3ClientConfig`

Defined in: [shared/codec/s3/config.ts:10](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/b9d505b52648c7e723f3e953aac58e9fe52a329f/src/shared/codec/s3/config.ts#L10)

***

### createS3Client?

> `optional` **createS3Client?**: (`config`) => `S3Client`

Defined in: [shared/codec/s3/config.ts:11](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/b9d505b52648c7e723f3e953aac58e9fe52a329f/src/shared/codec/s3/config.ts#L11)

#### Parameters

##### config

`S3ClientConfig`

#### Returns

`S3Client`

***

### keyPrefix?

> `optional` **keyPrefix?**: `string`

Defined in: [shared/codec/s3/config.ts:6](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/b9d505b52648c7e723f3e953aac58e9fe52a329f/src/shared/codec/s3/config.ts#L6)

***

### serverSideEncryption?

> `optional` **serverSideEncryption?**: `string`

Defined in: [shared/codec/s3/config.ts:8](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/b9d505b52648c7e723f3e953aac58e9fe52a329f/src/shared/codec/s3/config.ts#L8)

***

### sseKmsKeyId?

> `optional` **sseKmsKeyId?**: `string`

Defined in: [shared/codec/s3/config.ts:9](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/b9d505b52648c7e723f3e953aac58e9fe52a329f/src/shared/codec/s3/config.ts#L9)

***

### thresholdBytes?

> `optional` **thresholdBytes?**: `number`

Defined in: [shared/codec/s3/config.ts:7](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/b9d505b52648c7e723f3e953aac58e9fe52a329f/src/shared/codec/s3/config.ts#L7)
