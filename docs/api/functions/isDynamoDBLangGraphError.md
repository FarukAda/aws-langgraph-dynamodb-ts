[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / isDynamoDBLangGraphError

# Function: isDynamoDBLangGraphError()

> **isDynamoDBLangGraphError**(`value`): `value is AnyDynamoDBLangGraphError`

Defined in: [shared/errors/base-error.ts:202](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L202)

Whether `value` is one of this library's errors.

Accepts: whatever a `catch` clause binds, as it is — an error from any realm
or any copy of this package, and any other value a `throw` can produce:
`null`, `undefined`, a string, a number, a symbol. Declared `unknown`
because that is what `strict` types a `catch` binding, and the documented
place to call this is the first line inside one.

Returns: whether it carries the brand, narrowed to the union discriminated by
`code`. A symbol registered by name, not `instanceof`: two copies of this
package in one dependency tree produce two classes but one symbol, and an
error crossing a realm boundary keeps its properties while losing its
prototype. Anything that cannot carry a property answers `false`. Earlier
releases set the same brand, so an older copy of this package installed
beside this one has its errors recognised too — in that release's shape: no
`details`, the counts as flat properties, and possibly a code this union
does not list (`UPSTREAM`).

Throws: nothing. The `in` operator raises a `TypeError` on a non-object, and
a guard that throws inside the `catch` it was called from would replace the
failure the caller is reporting with one of its own.

## Parameters

### value

`unknown`

## Returns

`value is AnyDynamoDBLangGraphError`
