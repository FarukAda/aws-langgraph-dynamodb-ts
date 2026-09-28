[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / AnyDynamoDBLangGraphError

# Type Alias: AnyDynamoDBLangGraphError

> **AnyDynamoDBLangGraphError** = `{ [C in ErrorCode]: DynamoDBLangGraphError<C> }`\[[`ErrorCode`](../enumerations/ErrorCode.md)\]

Defined in: [shared/errors/base-error.ts:168](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L168)

Every library error, as a union discriminated by `code`: comparing `code`
narrows `details` to the shape that code carries.
