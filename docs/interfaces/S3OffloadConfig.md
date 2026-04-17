[**AWS LangGraph DynamoDB TypeScript v0.2.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / S3OffloadConfig

# Interface: S3OffloadConfig

Defined in: [shared/utils/s3-offloader.ts:49](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/shared/utils/s3-offloader.ts#L49)

Configuration for S3 offloading

## Properties

### bucketName

> **bucketName**: `string`

Defined in: [shared/utils/s3-offloader.ts:51](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/shared/utils/s3-offloader.ts#L51)

S3 bucket name for storing offloaded payloads (required)

***

### clientConfig?

> `optional` **clientConfig?**: `object`

Defined in: [shared/utils/s3-offloader.ts:68](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/shared/utils/s3-offloader.ts#L68)

Optional S3 client configuration (region, credentials, endpoint, etc.).
Accepts any valid S3ClientConfig properties from @aws-sdk/client-s3.

#### Index Signature

\[`key`: `string`\]: `unknown`

#### credentials?

> `optional` **credentials?**: `unknown`

#### endpoint?

> `optional` **endpoint?**: `string`

#### region?

> `optional` **region?**: `string`

***

### keyPrefix?

> `optional` **keyPrefix?**: `string`

Defined in: [shared/utils/s3-offloader.ts:53](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/shared/utils/s3-offloader.ts#L53)

Key prefix for S3 objects (default: 'langgraph-checkpoints/')

***

### serverSideEncryption?

> `optional` **serverSideEncryption?**: `string`

Defined in: [shared/utils/s3-offloader.ts:61](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/shared/utils/s3-offloader.ts#L61)

Server-side encryption algorithm (`'AES256'` or `'aws:kms'`).
Defaults to `'AES256'` — pass an explicit value to override (e.g. `'aws:kms'`
together with `sseKmsKeyId`).

***

### sseKmsKeyId?

> `optional` **sseKmsKeyId?**: `string`

Defined in: [shared/utils/s3-offloader.ts:63](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/shared/utils/s3-offloader.ts#L63)

KMS key ID or ARN. Only used when serverSideEncryption is 'aws:kms'.

***

### thresholdBytes?

> `optional` **thresholdBytes?**: `number`

Defined in: [shared/utils/s3-offloader.ts:55](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/shared/utils/s3-offloader.ts#L55)

Payload size threshold in bytes that triggers offloading (default: 358400 = 350KB)
