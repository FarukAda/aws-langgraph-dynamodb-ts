[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / S3ClientConfigLike

# Type Alias: S3ClientConfigLike

> **S3ClientConfigLike** = `S3ClientOptions` \| `object`

Defined in: [shared/codec/s3/client-types.ts:23](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/codec/s3/client-types.ts#L23)

Structural stand-in for `S3ClientConfig`, so the shipped declarations compile
without the optional `@aws-sdk/client-s3` peer installed. A literal gets
completion for the options the library uses; a typed `S3ClientConfig`
variable is accepted as it is.
