[**AWS LangGraph DynamoDB TypeScript v0.2.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / CompressionConfig

# Interface: CompressionConfig

Defined in: [shared/utils/compressor.ts:40](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/shared/utils/compressor.ts#L40)

Configuration for checkpoint compression

## Properties

### enabled

> **enabled**: `boolean`

Defined in: [shared/utils/compressor.ts:42](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/shared/utils/compressor.ts#L42)

Whether compression is enabled (default: false)

***

### level?

> `optional` **level?**: `number`

Defined in: [shared/utils/compressor.ts:46](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/shared/utils/compressor.ts#L46)

Gzip compression level 1-9 (default: 6 = balanced speed/ratio)

***

### maxDecompressedBytes?

> `optional` **maxDecompressedBytes?**: `number`

Defined in: [shared/utils/compressor.ts:52](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/shared/utils/compressor.ts#L52)

Hard cap on decompressed output size in bytes (default: 50 MiB).
Protects against gzip-bomb payloads. Decompression throws if the output
would exceed this cap.

***

### minSizeBytes?

> `optional` **minSizeBytes?**: `number`

Defined in: [shared/utils/compressor.ts:44](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/shared/utils/compressor.ts#L44)

Minimum payload size in bytes to trigger compression (default: 1024 = 1KB)
