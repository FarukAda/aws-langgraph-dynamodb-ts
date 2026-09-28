[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBLangGraphError

# Class: DynamoDBLangGraphError\<C\>

Defined in: [shared/errors/base-error.ts:120](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L120)

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

Defined in: [shared/errors/base-error.ts:148](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L148)

Accepts: `message` — already redacted by whoever composed it, since it reaches
`err.message`, which an application may print without a redacting logger.
`code` — the code this error branches on. `context` — identifiers and counts
only, never a payload or a credential. It is **copied**, so a caller that
reuses one builder object cannot rewrite the context of an error already in
flight; `null` reads as an absent one. `cause` — the failure below this one,
kept as the native `cause` chain. `details` — the code-specific record
[ErrorDetailsByCode](../interfaces/ErrorDetailsByCode.md) names, copied like `context`. The parameter is
optional for every code, including the two whose `details` property is
typed as always present (`BATCH_WRITE_INCOMPLETE`, `COMPENSATION_FAILED`):
nothing at compile time stops a direct `new` from leaving it out, and an
error built that way has no `details` at runtime whatever its type says.
Inside this package those two codes are only ever built by the factories
that always pass them.

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

Defined in: [shared/errors/base-error.ts:121](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L121)

***

### context

> `readonly` **context**: [`ErrorContext`](../interfaces/ErrorContext.md)

Defined in: [shared/errors/base-error.ts:122](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L122)

***

### details

> `readonly` **details**: [`ErrorDetailsFor`](../type-aliases/ErrorDetailsFor.md)\<`C`\>

Defined in: [shared/errors/base-error.ts:124](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L124)

Declared, not emitted: a code without details leaves no `undefined`-valued own property.
