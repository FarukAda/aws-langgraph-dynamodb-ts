[**AWS LangGraph DynamoDB TypeScript v0.9.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / CodecOptions

# Interface: CodecOptions

Defined in: shared/options.ts:29

Options enabling payload compression and/or S3 offloading.

## Properties

### compression?

> `optional` **compression?**: [`CompressionConfig`](CompressionConfig.md)

Defined in: shared/options.ts:31

Gzip compression configuration.

***

### s3?

> `optional` **s3?**: [`S3OffloadConfig`](S3OffloadConfig.md)

Defined in: shared/options.ts:33

S3 offload configuration for payloads over DynamoDB's item limit.
