[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / redactLogger

# Function: redactLogger()

> **redactLogger**(`inner`, `options?`): [`Logger`](../interfaces/Logger.md)

Defined in: [shared/logging/redaction.ts:198](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/logging/redaction.ts#L198)

Wrap a logger so object args are redacted before delegation.

Accepts: `inner` — the logger to delegate to; it must carry all four
methods, because a missing one is a wiring mistake worth naming here rather
than at the first log line. `options.extraKeys` — further key names to
redact, matched like the defaults. `options.extraValuePatterns` — further
secret shapes; each must be a `RegExp`, and it is applied globally whether or
not it carries the `g` flag.

Returns: a logger with the same four methods.

Throws: `VALIDATION` naming `logger` or `logger.<method>` for a logger it
could not delegate to, and `options`, `extraKeys` or `extraValuePatterns`
for an option of the wrong type. Nothing at log time.

Guarantees: the message string is passed through unchanged — never
interpolate a secret into it — and every other argument is redacted before
it reaches `inner`. Past the wrap call nothing escapes a log call: an
argument whose redaction fails is replaced by a fixed marker, and a failure
of `inner` itself is absorbed (`absorbLoggerFailure`), because the
operation that wrote the line was only observing itself and is commonly
reporting some other failure already.

## Parameters

### inner

[`Logger`](../interfaces/Logger.md)

### options?

[`RedactLoggerOptions`](../interfaces/RedactLoggerOptions.md) = `{}`

## Returns

[`Logger`](../interfaces/Logger.md)
