[**AWS LangGraph DynamoDB TypeScript v0.3.1**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / redactSecrets

# Function: redactSecrets()

> **redactSecrets**(`value`, `patterns?`): `Redactable`

Defined in: [shared/logging/redaction.ts:37](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/shared/logging/redaction.ts#L37)

Recursively clone `value`, replacing any value at a secret-looking key with
`[REDACTED]`. Cycles become `[Circular]`. Error objects are passed through so
stack traces survive. Does not mutate the input.

## Parameters

### value

`Redactable`

### patterns?

readonly `string`[] = `DEFAULT_SECRET_KEY_PATTERNS`

## Returns

`Redactable`
