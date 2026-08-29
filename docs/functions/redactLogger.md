[**AWS LangGraph DynamoDB TypeScript v0.8.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / redactLogger

# Function: redactLogger()

> **redactLogger**(`inner`, `options?`): [`Logger`](../interfaces/Logger.md)

Defined in: [shared/logging/redaction.ts:56](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/b9d505b52648c7e723f3e953aac58e9fe52a329f/src/shared/logging/redaction.ts#L56)

Wrap a logger so object args are redacted before delegation. The message
string is passed through unchanged (never interpolate secrets into it).

## Parameters

### inner

[`Logger`](../interfaces/Logger.md)

### options?

`RedactLoggerOptions` = `{}`

## Returns

[`Logger`](../interfaces/Logger.md)
