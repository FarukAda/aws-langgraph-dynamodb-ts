[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / S3ClientLike

# Interface: S3ClientLike

Defined in: [shared/codec/s3/client-types.ts:39](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/codec/s3/client-types.ts#L39)

The S3 client surface this library calls, typed structurally for the same
reason. `S3Client` from `@aws-sdk/client-s3` satisfies it.

## Methods

### destroy()

> **destroy**(): `void`

Defined in: [shared/codec/s3/client-types.ts:41](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/codec/s3/client-types.ts#L41)

#### Returns

`void`

***

### send()

> **send**(`command`, `options?`): `Promise`\<`object`\>

Defined in: [shared/codec/s3/client-types.ts:40](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/codec/s3/client-types.ts#L40)

#### Parameters

##### command

[`S3CommandLike`](S3CommandLike.md)

##### options?

`object`

#### Returns

`Promise`\<`object`\>
