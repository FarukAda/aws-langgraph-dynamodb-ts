[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / CodecOptions

# Interface: CodecOptions

Defined in: [shared/options.ts:91](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/options.ts#L91)

Options enabling payload compression and/or S3 offloading.

## Properties

### compression?

> `optional` **compression?**: [`CompressionConfig`](CompressionConfig.md)

Defined in: [shared/options.ts:93](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/options.ts#L93)

Gzip compression configuration.

***

### s3?

> `optional` **s3?**: [`S3OffloadConfig`](S3OffloadConfig.md)

Defined in: [shared/options.ts:95](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/options.ts#L95)

S3 offload configuration for payloads over DynamoDB's item limit.
