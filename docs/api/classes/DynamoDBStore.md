[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBStore

# Class: DynamoDBStore

Defined in: [store/store.ts:63](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L63)

DynamoDB-backed LangGraph store for long-term memory with optional semantic
search. `get`, `put`, `delete` and `listNamespaces` answer and refuse exactly
as the same operation inside a [batch](#batch) does, and `put` keeps upstream's
own namespace rules. Every public method rejects only with this library's
error.

## Extends

- `BaseStore`

## Constructors

### Constructor

> **new DynamoDBStore**(`options`): `DynamoDBStore`

Defined in: [store/store.ts:80](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L80)

Accepts: `options` — validated here, so a misconfiguration surfaces at
construction rather than on the first request. A `vectorBackend` without an
`index` is refused outright, since every put would then clear the item's
vector and every query would answer unranked.

Returns: a store that owns the client it built, or borrows the one it was
given.

Throws: `VALIDATION` naming the offending option.

Guarantees: no I/O. Constructing a store issues no request.

#### Parameters

##### options

[`DynamoDBStoreOptions`](../type-aliases/DynamoDBStoreOptions.md)

#### Returns

`DynamoDBStore`

#### Overrides

`BaseStore.constructor`

## Methods

### batch()

> **batch**\<`Op`\>(`operations`): `Promise`\<`OperationResults`\<`Op`\>\>

Defined in: [store/store.ts:177](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L177)

Execute a batch of operations and return their results in operation
order.

Accepts: `operations` — an array of operation objects, in the order they
are to be observed; an empty batch does nothing and returns `[]`. Every
operation is checked before any of them runs. A put carrying a `null`
value deletes its item. `get`, `put`, `delete` and `listNamespaces` check
their own call by the same rules and run the same dispatch, as upstream's
implementations do, so the field a malformed call names is the same
whichever of the five reached it — `put` alone adds what is about the
method: upstream's own `.` and `"langgraph"` namespace rules, and a refusal
of a `null` value, since `delete` is how an item is removed. Each of the
four keeps its own name in `context.operation`, so a failure says which
method the caller called rather than reporting all five alike.

Returns: the results in operation order — an item or `null` for a get,
matches for a search, namespaces for a listing, `null` for a put or a
delete, as the reference store answers them.

Throws: `VALIDATION`, raised for every operation before any operation
runs, naming `operations` for a value that is not an array or an entry that
is not an object; `namespace`, `namespace element`, `key` or `sortKey` for an
item address; `value` or `index` for a put; `namespacePrefix`,
`namespacePrefix element`, `filter`, `query`, `offset` or `limit` for a
search; `offset`, `limit`, `maxDepth`, `matchConditions`, `prefix`,
`prefix element`, `suffix` or `suffix element` for a listing; and later,
from a running operation, `value` for one JSON cannot represent,
`maxSearchCandidates` or `index.dims`, or — once a put's row is built —
`index` or `value` again for one over DynamoDB's 400 KB item limit, naming
`index` when its inline vectors are what pushed it over. A classified AWS
failure; `RETRY_EXHAUSTED`;
`RESULT_TRUNCATED` from a search or a listing that reads past
`maxScanItems` or `maxIterations`. One failing operation rejects the
whole batch.

Guarantees: the order the caller wrote is the order the caller observes — a
get after a put of the same item sees it, a get before one does not, and a
search sees every write that precedes it and none that follow. Operations
addressing different items run concurrently, so a batch of ten gets costs
about one round trip rather than ten, sharing one `readConcurrency`
decode budget between them rather than each holding a full one.

#### Type Parameters

##### Op

`Op` *extends* `Operation`[]

#### Parameters

##### operations

`Op`

#### Returns

`Promise`\<`OperationResults`\<`Op`\>\>

#### Overrides

`BaseStore.batch`

***

### delete()

> **delete**(`namespace`, `key`): `Promise`\<`void`\>

Defined in: [store/store.ts:295](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L295)

Remove one item, as upstream does: a put operation carrying `null`.

Accepts: `namespace` and `key` — as [get](#get).

Returns: nothing. Deleting an item that is not there is not an error —
which now describes the outcome rather than the round trip, since the row
is read before it is removed.

Throws: `VALIDATION` naming `namespace`, `namespace element`, `key` or
`sortKey`; a classified AWS failure; `RETRY_EXHAUSTED`. The set of types is
unchanged, but the occasions are not: that pre-read is a request like any
other, so a delete of a key with **no row** can now fail where it always
succeeded. Nothing has been written when it does — no row removed, no
object released, no vector touched. A delete the row's revision turns away
never reaches a caller at all: it is re-pinned on the row the rejection
returned and re-issued, because refusing to remove a row a concurrent put
replaced is what stops this call erasing that put.

Guarantees: the item is gone, was already gone, or — when three attempts in
a row are each turned away by a write that landed since the observation
that attempt pinned — is still there and was left alone. That last case
**resolves**, logging one `warn` naming the namespace, the key and the
attempt count, where the reference store always removes the item;
throwing instead would add a failure mode to an interleaving that succeeds
today, which every caller deleting in a `finally` would have to handle.
Re-run once the key is quiescent. Nothing is released on that path, which
is correct: a live row still names the object.

#### Parameters

##### namespace

`string`[]

##### key

`string`

#### Returns

`Promise`\<`void`\>

#### Overrides

`BaseStore.delete`

***

### destroy()

> **destroy**(): `void`

Defined in: [store/store.ts:442](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L442)

Release owned resources.

Accepts: nothing.

Returns: nothing. Idempotent, and a no-op for a client the caller injected
— that one is theirs to close.

Throws: the first failure a resource's own `destroy` raised, as a
`DynamoDBLangGraphError` (`UNEXPECTED_ERROR` unless the failure was AWS's)
with it as `cause` — raised only after every other resource has been
released, and only by the first call: `destroy()` is idempotent.

#### Returns

`void`

***

### ensureS3LifecycleRule()

> **ensureS3LifecycleRule**(): `Promise`\<`void`\>

Defined in: [store/store.ts:472](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L472)

Provision an S3 lifecycle expiration rule matching the configured TTL, so
offloaded objects don't outlive their DynamoDB item forever.

Accepts: nothing; the rule follows the configured `s3` and `ttl`. A no-op
without both.

Returns: nothing. Installing a rule that is already there is a no-op too,
so calling it on every deploy is safe. When it writes the rules but
cannot confirm within its polling window that a re-read shows them — S3
documents that a lifecycle configuration can take minutes to propagate —
it logs a `warn` and returns rather than throwing: the rules were
written, and a later call can confirm them.

Throws: `VALIDATION` naming `s3.keyPrefix` on a rule-id collision;
a classified AWS failure when the bucket's lifecycle cannot be read or
written; `CONTENTION` when every one of the five rounds this call polls
needs a write — a competing writer replacing the configuration on every
single re-read.

#### Returns

`Promise`\<`void`\>

#### Remarks

Requires the bucket-level `s3:GetLifecycleConfiguration` /
`s3:PutLifecycleConfiguration` permissions, broader than the object-level
CRUD the rest of S3 offload needs — call it once during provisioning, not
per request. When several adapters or processes provision the same
bucket, call them one at a time and run each again after a few minutes
once every one of them has run.

***

### get()

> **get**(`namespace`, `key`): `Promise`\<`Item` \| `null`\>

Defined in: [store/store.ts:216](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L216)

Retrieve one item. Overrides the base implementation so the call is
guarded here; the operation is the one upstream builds.

Accepts: `namespace` — at least one label, each a non-blank identifier of
at most 256 bytes, free of `#` and control characters and well-formed
UTF-16. A `.` and a `"langgraph"` root are accepted, as the reference store
accepts them. `key` — an identifier by the same rules. Together they may
compose a sort key of at most 1024 bytes. **No signal**: upstream's
`BaseStore.get` takes no parameter for one, so the S3 download an
offloaded value costs is not cancellable here. `store.search` is the read
that takes one.

Returns: the item, or `null` for one that does not exist or has expired.

Throws: `VALIDATION` naming `namespace`, `namespace element`, `key` or
`sortKey`, and — from the row rather than from the call — `descriptor` for
a payload descriptor no reader could make sense of, `s3` for an offloaded
row with no offloader configured, `s3Key` for a row addressing an object
outside its own path, or `serde` for a payload the configured serializer
refuses to reconstruct; `FORMAT_UNSUPPORTED` for an item, or its payload,
written by a newer version, which is reported rather than hidden as
absent; `PAYLOAD_CORRUPT` for a payload that is no longer the form its row
declares; `S3_OFFLOAD_FAILED` for an offloaded payload that cannot be
downloaded; `COMPRESSION_LIMIT` for one whose decompressed size would pass
the cap; a classified AWS failure; `RETRY_EXHAUSTED`. Not `ABORTED`: there is no
signal to fire.

#### Parameters

##### namespace

`string`[]

##### key

`string`

#### Returns

`Promise`\<`Item` \| `null`\>

#### Overrides

`BaseStore.get`

***

### listNamespaces()

> **listNamespaces**(`options?`): `Promise`\<`string`[][]\>

Defined in: [store/store.ts:322](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L322)

List the distinct namespaces, sorted, optionally filtered and truncated.

Accepts: `options.prefix`/`suffix` — labels a namespace can hold, where
`'*'` matches any one label. `options.maxDepth` — at least 1.
`options.limit` — an integer from 0 to `MAX_PAGE_LIMIT` (10,000), defaulting
to 100, where `0` returns an empty listing without reading the table.
`options.offset` — a non-negative integer, defaulting to 0.

Returns: at most `limit` namespaces from `offset`.

Throws: `VALIDATION` naming `options`, `options.<key>`, `prefix`,
`prefix element`, `suffix`, `suffix element`, `maxDepth`, `limit` or
`offset`; `RESULT_TRUNCATED` past `maxScanItems` or `maxIterations`;
`FORMAT_UNSUPPORTED` for an item written by a newer version; a classified
AWS failure.

#### Parameters

##### options?

[`ListNamespacesOptions`](../interfaces/ListNamespacesOptions.md) = `{}`

#### Returns

`Promise`\<`string`[][]\>

#### Overrides

`BaseStore.listNamespaces`

***

### put()

> **put**(`namespace`, `key`, `value`, `index?`): `Promise`\<`void`\>

Defined in: [store/store.ts:251](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L251)

Store or replace one item. Overrides the base implementation, whose own
namespace check threw an error this package does not brand. The value and
index are checked by [batch](#batch), so LangGraph's own puts hold them too.

Accepts: `namespace` and `key` — as [get](#get), plus upstream
`BaseStore.put`'s own two rules, which only this method applies: no label
holding `.`, and a root other than `"langgraph"`. `value` — an object; `null`
is refused, since [delete](#delete) is how an item is removed. `index` —
absent uses the store's configuration, `false` indexes nothing, and field
paths override it for this put.

Returns: nothing.

Throws: `VALIDATION` naming `namespace`, `namespace element`, `key`,
`sortKey`, `value` or `index`; `payload` for a value too large to store
inline without `s3`, or, once offloaded, larger than
`s3.maxDownloadBytes`; `VALIDATION` again, naming `index` or `value`, for
the built row over DynamoDB's 400 KB item limit — `index` when its inline
vectors are what pushed it over — checked before anything is written; a
classified AWS failure; `RETRY_EXHAUSTED`.

#### Parameters

##### namespace

`string`[]

##### key

`string`

##### value

`Record`\<`string`, `any`\>

##### index?

`false` \| `string`[]

#### Returns

`Promise`\<`void`\>

#### Overrides

`BaseStore.put`

***

### reconcileVectorIndex()

> **reconcileVectorIndex**(`namespacePrefix`, `options?`): `Promise`\<[`VectorReconcileResult`](../interfaces/VectorReconcileResult.md)\>

Defined in: [store/store.ts:399](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L399)

Repair the configured vector backend against the canonical items under
`namespacePrefix`. A maintenance tool; see the action of the same name.

Accepts: `namespacePrefix` — a non-empty namespace. `options.signal` —
aborts between pages.

Returns: how many vectors were upserted and how many pruned.

Throws: `VALIDATION` without both an `index` and a `vectorBackend`, for
an empty prefix, for an invalid `signal`, or for `options.<key>` naming a
key this package does not read; `RESULT_TRUNCATED` past `maxScanItems` or
`maxIterations`; `FORMAT_UNSUPPORTED` for an item, or its payload, written by a newer
version — repairing a backend from a view of the prefix that silently
omitted such a row would prune the vectors of items that are still there;
a classified AWS failure.

Guarantees: DynamoDB is never written — only the backend is repaired — and
a vector is deleted only on evidence that its item is gone, or unchanged
since a snapshot that already found it with nothing to embed.

#### Parameters

##### namespacePrefix

`string`[]

##### options?

[`CancelOptions`](../interfaces/CancelOptions.md)

#### Returns

`Promise`\<[`VectorReconcileResult`](../interfaces/VectorReconcileResult.md)\>

***

### search()

> **search**(`namespacePrefix`, `options?`): `Promise`\<`SearchItem`[]\>

Defined in: [store/store.ts:361](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L361)

Search with optional cancellation. Overrides the base implementation, which
routes through [batch](#batch) and therefore cannot carry a signal.

Accepts: `namespacePrefix` — labels a namespace can hold; empty spans the
whole table. `options.query` —
absent or empty ranks nothing. `options.filter` — metadata equality on the
item's value. `options.offset` — a non-negative integer, defaulting to 0.
`options.limit` — an integer from 0 to `MAX_PAGE_LIMIT` (10,000), defaulting
to 10, where `0` returns an empty page without a read or an embedding.
`options.signal` — aborts the reads.

Returns: at most `limit` items from `offset`, each carrying a `score` when
a query and an index are configured.

Throws: `VALIDATION` naming `namespacePrefix`, `namespacePrefix element`,
`filter`, `query`, `offset`, `limit`, `maxSearchCandidates`, `index.dims`,
`signal`, or
`options.<key>` for a key this package does not read; `ABORTED`;
`RESULT_TRUNCATED` when the walk reaches `maxScanItems` or `maxIterations`;
`FORMAT_UNSUPPORTED` for an item, or its payload, written by a newer
version — a search reads rows it did not name, so one such row anywhere in
the prefix it walks reports rather than being passed over; a classified AWS failure.

Guarantees: a plain search stops reading once `offset + limit` matches are
in hand; a query ranks in-process up to `maxSearchCandidates`, or through
the `vectorBackend` when one is configured.

#### Parameters

##### namespacePrefix

`string`[]

##### options?

[`SearchOptions`](../type-aliases/SearchOptions.md) = `{}`

#### Returns

`Promise`\<`SearchItem`[]\>

#### Overrides

`BaseStore.search`

***

### stop()

> **stop**(): `void`

Defined in: [store/store.ts:425](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L425)

LangGraph's lifecycle hook.

Accepts: nothing.

Returns: nothing. A host that manages stores through the upstream
`BaseStore` interface calls `stop()`, so it releases the owned client
exactly like [destroy](#destroy), which stays the explicit API. Both are
idempotent.

Throws: exactly what [destroy](#destroy) throws, since it is that call.

#### Returns

`void`

#### Overrides

`BaseStore.stop`
