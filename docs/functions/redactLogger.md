[**AWS LangGraph DynamoDB TypeScript v0.3.1**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / redactLogger

# Function: redactLogger()

> **redactLogger**(`inner`, `options?`): [`Logger`](../interfaces/Logger.md)

Defined in: [shared/logging/redaction.ts:65](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/shared/logging/redaction.ts#L65)

Wrap a logger so object args are redacted before delegation. The message
string is passed through unchanged (never interpolate secrets into it).

## Parameters

### inner

[`Logger`](../interfaces/Logger.md)

### options?

#### extraKeys?

readonly `string`[]

## Returns

[`Logger`](../interfaces/Logger.md)
