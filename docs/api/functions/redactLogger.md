[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / redactLogger

# Function: redactLogger()

> **redactLogger**(`inner`, `options?`): [`Logger`](../interfaces/Logger.md)

Defined in: [shared/logging/redaction.ts:165](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/logging/redaction.ts#L165)

Wrap a logger so object args are redacted before delegation.

Accepts: `inner` — the logger to delegate to. `options.extraKeys` — further
key names to redact, matched like the defaults. `options.extraValuePatterns`
— further secret shapes; each must be a `RegExp`, and it is applied globally
whether or not it carries the `g` flag.

Returns: a logger with the same four methods.

Throws: ValidationError naming `extraKeys` or `extraValuePatterns` for an
entry of the wrong type. Nothing at log time: an argument whose redaction
fails is replaced by a fixed marker rather than failing the library
operation that logged it.

Guarantees: the message string is passed through unchanged — never
interpolate a secret into it — and every other argument is redacted before
it reaches `inner`.

## Parameters

### inner

[`Logger`](../interfaces/Logger.md)

### options?

[`RedactLoggerOptions`](../interfaces/RedactLoggerOptions.md) = `{}`

## Returns

[`Logger`](../interfaces/Logger.md)
