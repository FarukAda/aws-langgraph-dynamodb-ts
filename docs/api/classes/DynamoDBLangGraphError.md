[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBLangGraphError

# Class: DynamoDBLangGraphError\<C\>

Defined in: [shared/errors/base-error.ts:105](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L105)

Base class for every error this library throws. Carries a branchable
[ErrorCode](../enumerations/ErrorCode.md), structured [ErrorContext](../interfaces/ErrorContext.md), code-specific
[details](#details), and a native `cause` chain. Detected via
[isDynamoDBLangGraphError](../functions/isDynamoDBLangGraphError.md) (a symbol brand) rather than `instanceof`,
which is banned repo-wide.

## Extends

- `Error`

## Type Parameters

### C

`C` *extends* [`ErrorCode`](../enumerations/ErrorCode.md) = [`ErrorCode`](../enumerations/ErrorCode.md)

## Constructors

### Constructor

> **new DynamoDBLangGraphError**\<`C`\>(`message`, `code`, `context?`, `cause?`, `details?`): `DynamoDBLangGraphError`\<`C`\>

Defined in: [shared/errors/base-error.ts:127](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L127)

Accepts: `message` — already redacted by whoever composed it, since it reaches
`err.message`, which an application may print without a redacting logger.
`code` — the code this error branches on. `context` — identifiers and counts
only, never a payload or a credential. It is **copied**, so a caller that
reuses one builder object cannot rewrite the context of an error already in
flight; `null` reads as an absent one. `cause` — the failure below this one,
kept as the native `cause` chain. `details` — the code-specific record
[ErrorDetailsByCode](../interfaces/ErrorDetailsByCode.md) names, copied like `context`.

Returns: the error, branded so [isDynamoDBLangGraphError](../functions/isDynamoDBLangGraphError.md) recognises it
across realms and across two copies of this package. The brand is
non-enumerable, so it never reaches a log or a JSON serialization.

Throws: nothing; building an error may not fail.

#### Parameters

##### message

`string`

##### code

`C`

##### context?

[`ErrorContext`](../interfaces/ErrorContext.md) = `{}`

##### cause?

`Error`

##### details?

[`ErrorDetailsFor`](../type-aliases/ErrorDetailsFor.md)\<`C`\>

#### Returns

`DynamoDBLangGraphError`\<`C`\>

#### Overrides

`Error.constructor`

## Properties

### code

> `readonly` **code**: `C`

Defined in: [shared/errors/base-error.ts:106](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L106)

***

### context

> `readonly` **context**: [`ErrorContext`](../interfaces/ErrorContext.md)

Defined in: [shared/errors/base-error.ts:107](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L107)

***

### details

> `readonly` **details**: [`ErrorDetailsFor`](../type-aliases/ErrorDetailsFor.md)\<`C`\>

Defined in: [shared/errors/base-error.ts:109](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L109)

Declared, not emitted: a code without details leaves no `undefined`-valued own property.
