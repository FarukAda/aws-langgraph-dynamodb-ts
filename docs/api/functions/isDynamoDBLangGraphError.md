[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / isDynamoDBLangGraphError

# Function: isDynamoDBLangGraphError()

> **isDynamoDBLangGraphError**(`value`): `value is DynamoDBLangGraphError`

Defined in: [shared/errors/base-error.ts:69](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L69)

Whether `value` is one of this library's errors.

Accepts: any error, from any realm or any copy of this package.

Returns: whether it carries the brand. A symbol registered by name, not
`instanceof`: two copies of this package in one dependency tree produce two
classes but one symbol, and an error crossing a realm boundary keeps its
properties while losing its prototype.

Throws: nothing.

## Parameters

### value

`Error`

## Returns

`value is DynamoDBLangGraphError`
