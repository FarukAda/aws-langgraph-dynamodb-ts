[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBDocumentLike

# Type Alias: DynamoDBDocumentLike

> **DynamoDBDocumentLike** = `Pick`\<`DynamoDBDocument`, `"batchWrite"` \| `"delete"` \| `"get"` \| `"put"` \| `"query"` \| `"scan"` \| `"transactWrite"` \| `"update"`\>

Defined in: [shared/dynamodb/client.ts:239](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/dynamodb/client.ts#L239)

The DocumentClient surface this library uses, named by shape rather than by
identity. A `DynamoDBDocument` satisfies it, and so does a client built from
a different copy of `@aws-sdk/lib-dynamodb`.

That second case is the reason it exists. A consumer pinned to an older SDK
than this package depends on gets a second, newer copy nested under the
package; naming `DynamoDBDocument` in an option type would name *that* copy,
and the client the consumer built is then a different type with the same
name — refused at compile time for a method this library never calls, on the
injection path the documentation recommends. Injection always worked at
runtime; only the compiler stood in the way.

The members are the eight the runtime collaborator check already requires,
pinned equal to that list by a test — a client this type accepts and the
constructor then rejects, or the reverse, would be worse than either rule
alone. Picking them off `DynamoDBDocument` keeps each signature the SDK's
own, so the internals stay exactly as type-safe as they were and the
signatures cannot drift from the SDK this package installs.
