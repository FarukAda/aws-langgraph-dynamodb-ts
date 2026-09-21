[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / redactSecrets

# Function: redactSecrets()

> **redactSecrets**(`value`, `patterns?`, `valuePatterns?`): [`Redactable`](../type-aliases/Redactable.md)

Defined in: [shared/logging/redaction.ts:72](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/logging/redaction.ts#L72)

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

Accepts: `value` — any log argument, including `undefined`, a primitive, a
typed `Error`, a class instance or a `Record`, so callers never cast. A
cyclic or shared graph is fine; each node is walked once. `patterns` and
`valuePatterns` — the key names and value shapes to redact, an array of
strings and an array of `RegExp` respectively; both default to this
package's own lists, and an empty one turns that rule off.

Returns: a redacted clone. The input is never mutated — a logger that
scrubbed the caller's own object would corrupt the very data the application
is working with.

Throws: ValidationError naming `patterns` or `valuePatterns` for a list this
function could not apply, which is a mistake in the call itself and is
raised before anything is walked. Nothing after that: a value whose
redaction fails — a throwing getter, a structure deep enough to exhaust the
stack — is replaced whole by `[UNREDACTABLE]`, since a logger that throws
takes down the operation it was only observing. [redactLogger](redactLogger.md)
redacts one argument per call, so there a single hostile argument is what is
lost rather than the record around it.

## Parameters

### value

[`LogArgument`](../type-aliases/LogArgument.md) \| `undefined`

### patterns?

readonly `string`[] = `DEFAULT_SECRET_KEY_PATTERNS`

### valuePatterns?

readonly `RegExp`[] = `DEFAULT_SECRET_VALUE_PATTERNS`

## Returns

[`Redactable`](../type-aliases/Redactable.md)
