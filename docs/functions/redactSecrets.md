[**AWS LangGraph DynamoDB TypeScript v0.9.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / redactSecrets

# Function: redactSecrets()

> **redactSecrets**(`value`, `patterns?`, `valuePatterns?`): `Redactable`

Defined in: shared/logging/redaction.ts:24

Recursively clone `value`, replacing any value at a secret-looking key with
`[REDACTED]` and any recognised secret *shape* inside a string — including an
error's `message`/`stack` text, which key-name matching cannot reach — with
the same marker. Cycles become `[Circular]`.

An Error with no own enumerable properties whose text holds no secret is
passed through by reference, so its identity and stack trace survive; one
carrying own data (this library's error types all attach `code`/`context`
this way) or a secret in its text is rebuilt instead, with `name`/`message`/
`stack` redacted and every other own property recursed like a plain object.
`Date`/`RegExp` keep their identity rather than collapsing to `{}`,
`Set`/`Map` render as their contents, and binary views become a short label.
Does not mutate the input.

## Parameters

### value

`Redactable`

### patterns?

readonly `string`[] = `DEFAULT_SECRET_KEY_PATTERNS`

### valuePatterns?

readonly `RegExp`[] = `DEFAULT_SECRET_VALUE_PATTERNS`

## Returns

`Redactable`
