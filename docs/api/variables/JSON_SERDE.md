[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / JSON\_SERDE

# Variable: JSON\_SERDE

> `const` **JSON\_SERDE**: `SerializerProtocol`

Defined in: [shared/codec/json-serde.ts:46](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/codec/json-serde.ts#L46)

A plain JSON serializer implementing LangGraph's `SerializerProtocol`:
the default `serde` of `DynamoDBStore` and `DynamoDBChatMessageHistory`, and
the alternative a `DynamoDBSaver` can be given in place of LangGraph's
`JsonPlusSerializer`.

It is exported so that choice is available. The checkpointer's default
revives a stored `{"lc": …}` record by instantiating the class the record
names, so the row selects which constructor runs on read; this serializer
runs `JSON.parse` and nothing else, and reconstructs no class at all.
Reading with it is the narrower trust boundary, and the price is stated
below: it stores the JSON projection of a value, not the value.

`dumpsTyped` accepts any value `JSON.stringify` can represent and refuses the
rest. A value it cannot represent — `undefined`, a function, a symbol —
stringifies to `undefined` and would be stored as **zero bytes**, which reads
back as a parse error; a circular structure or a `BigInt` makes it throw. Both
are reported as `ValidationError` naming `value`, at the write, rather than
as an unreadable row later.

What it represents, it represents as JSON, which is lossy in ways nothing
records: a `Map` or `Set` stores as `{}`, an object key whose value is
`undefined` is dropped and an array element is stored as `null`, `NaN` and
`Infinity` store as `null`, `-0` as `0`, a `Uint8Array` as an index-keyed
object and a `Date` as an ISO string. The README's *Table schema* section
holds the whole table, against the checkpointer default column by column.

`loadsTyped` accepts the bytes or text `dumpsTyped` produced. Bytes that do
not parse are `PAYLOAD_CORRUPT`, because they can never be read and the
caller should report rather than retry; a `data` that is not bytes at all is
a `ValidationError` naming `data`, because that is the caller's mistake and
not a row's.

Frozen for the reason [ErrorCode](../enumerations/ErrorCode.md) is: one object, shared by every
adapter in the process that did not pass a `serde` of its own, and now
reachable from the package root. An assignment to `dumpsTyped` by any one
consumer would silently change how every other one writes.
