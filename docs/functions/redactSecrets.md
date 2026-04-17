[**AWS LangGraph DynamoDB TypeScript v0.2.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / redactSecrets

# Function: redactSecrets()

> **redactSecrets**(`value`, `patterns?`): `unknown`

Defined in: [shared/utils/logger.ts:116](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/shared/utils/logger.ts#L116)

Recursively clone an object, replacing values at any secret-looking key with
`[REDACTED]`. Cycles are broken with a WeakSet. Leaves primitives and non-
enumerable values untouched. Does not mutate the input.

## Parameters

### value

`unknown`

Arbitrary value to redact

### patterns?

readonly `string`[] = `DEFAULT_SECRET_KEY_PATTERNS`

Lower-cased substrings to match against each key

## Returns

`unknown`
