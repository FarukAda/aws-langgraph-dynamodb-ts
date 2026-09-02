[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / RedactLoggerOptions

# Interface: RedactLoggerOptions

Defined in: [shared/logging/redaction.ts:50](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/logging/redaction.ts#L50)

Options controlling [redactLogger](../functions/redactLogger.md).

## Properties

### extraKeys?

> `optional` **extraKeys?**: readonly `string`[]

Defined in: [shared/logging/redaction.ts:56](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/logging/redaction.ts#L56)

Additional key names to redact. Matched like the defaults: a key is
redacted when its normalised form (lower-case, punctuation removed) equals
or ends with the normalised name, so `'ssn'` covers `SSN` and `user_ssn`.

***

### extraValuePatterns?

> `optional` **extraValuePatterns?**: readonly `RegExp`[]

Defined in: [shared/logging/redaction.ts:62](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/shared/logging/redaction.ts#L62)

Additional secret shapes to redact wherever they appear inside a string.
A pattern's first capture group, if it has one, is preserved verbatim and
only the remainder of the match is replaced.
