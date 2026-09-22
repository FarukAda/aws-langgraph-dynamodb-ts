[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / S3ClientLike

# Interface: S3ClientLike

Defined in: [shared/codec/s3/client-types.ts:49](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/codec/s3/client-types.ts#L49)

The S3 client surface this library calls, typed structurally for the same
reason. `S3Client` from `@aws-sdk/client-s3` satisfies it.

## Methods

### destroy()

> **destroy**(): `void`

Defined in: [shared/codec/s3/client-types.ts:51](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/codec/s3/client-types.ts#L51)

#### Returns

`void`

***

### send()

> **send**(`command`, `options?`): `Promise`\<`object`\>

Defined in: [shared/codec/s3/client-types.ts:50](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/codec/s3/client-types.ts#L50)

#### Parameters

##### command

[`S3CommandLike`](S3CommandLike.md)

##### options?

`object`

#### Returns

`Promise`\<`object`\>
