[**AWS LangGraph DynamoDB TypeScript v0.3.1**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / CodecOptions

# Interface: CodecOptions

Defined in: [shared/options.ts:29](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/shared/options.ts#L29)

Options enabling payload compression and/or S3 offloading.

## Properties

### compression?

> `optional` **compression?**: [`CompressionConfig`](CompressionConfig.md)

Defined in: [shared/options.ts:31](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/shared/options.ts#L31)

Gzip compression configuration.

***

### s3?

> `optional` **s3?**: [`S3OffloadConfig`](S3OffloadConfig.md)

Defined in: [shared/options.ts:33](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/shared/options.ts#L33)

S3 offload configuration for payloads over DynamoDB's item limit.
