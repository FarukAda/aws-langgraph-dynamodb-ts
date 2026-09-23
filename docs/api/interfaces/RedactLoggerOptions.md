[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / RedactLoggerOptions

# Interface: RedactLoggerOptions

Defined in: [shared/logging/redaction.ts:121](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/logging/redaction.ts#L121)

Options controlling [redactLogger](../functions/redactLogger.md).

## Properties

### extraKeys?

> `optional` **extraKeys?**: readonly `string`[]

Defined in: [shared/logging/redaction.ts:127](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/logging/redaction.ts#L127)

Additional key names to redact. Matched like the defaults: a key is
redacted when its normalised form (lower-case, punctuation removed) equals
or ends with the normalised name, so `'ssn'` covers `SSN` and `user_ssn`.

***

### extraValuePatterns?

> `optional` **extraValuePatterns?**: readonly `RegExp`[]

Defined in: [shared/logging/redaction.ts:133](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/logging/redaction.ts#L133)

Additional secret shapes to redact wherever they appear inside a string.
A pattern's first capture group, if it has one, is preserved verbatim and
only the remainder of the match is replaced.
