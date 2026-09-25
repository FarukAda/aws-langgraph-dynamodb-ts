[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / CodecOptions

# Interface: CodecOptions

Defined in: [shared/options.ts:84](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/options.ts#L84)

Options enabling payload compression and/or S3 offloading.

## Properties

### compression?

> `optional` **compression?**: [`CompressionConfig`](CompressionConfig.md)

Defined in: [shared/options.ts:86](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/options.ts#L86)

Gzip compression configuration.

***

### s3?

> `optional` **s3?**: [`S3OffloadConfig`](S3OffloadConfig.md)

Defined in: [shared/options.ts:88](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/options.ts#L88)

S3 offload configuration for payloads over DynamoDB's item limit.
