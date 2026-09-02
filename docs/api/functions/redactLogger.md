[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / redactLogger

# Function: redactLogger()

> **redactLogger**(`inner`, `options?`): [`Logger`](../interfaces/Logger.md)

Defined in: [shared/logging/redaction.ts:86](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/logging/redaction.ts#L86)

Wrap a logger so object args are redacted before delegation. The message
string is passed through unchanged (never interpolate secrets into it).

## Parameters

### inner

[`Logger`](../interfaces/Logger.md)

### options?

[`RedactLoggerOptions`](../interfaces/RedactLoggerOptions.md) = `{}`

## Returns

[`Logger`](../interfaces/Logger.md)
