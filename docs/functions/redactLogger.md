[**AWS LangGraph DynamoDB TypeScript v0.9.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / redactLogger

# Function: redactLogger()

> **redactLogger**(`inner`, `options?`): [`Logger`](../interfaces/Logger.md)

Defined in: shared/logging/redaction.ts:60

Wrap a logger so object args are redacted before delegation. The message
string is passed through unchanged (never interpolate secrets into it).

## Parameters

### inner

[`Logger`](../interfaces/Logger.md)

### options?

`RedactLoggerOptions` = `{}`

## Returns

[`Logger`](../interfaces/Logger.md)
