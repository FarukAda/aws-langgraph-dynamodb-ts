[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBStore

# Class: DynamoDBStore

Defined in: [store/store.ts:39](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L39)

DynamoDB-backed LangGraph store for long-term memory with optional semantic
search. A thin orchestrator: get/put/delete/listNamespaces build the same
operations the base class builds and funnel them into [batch](#batch), which
validates every operation and then dispatches each one; they are overridden
so each call is guarded in this package, and so `put` keeps upstream's own
namespace rules.

## Extends

- `BaseStore`

## Constructors

### Constructor

> **new DynamoDBStore**(`options`): `DynamoDBStore`

Defined in: [store/store.ts:57](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L57)

Accepts: `options` — validated here, so a misconfiguration surfaces at
construction rather than on the first request. A `vectorBackend` without an
`index` is refused outright, since every put would then clear the item's
vector and every query would answer unranked.

Returns: a store that owns the client it built, or borrows the one it was
given.

Throws: ValidationError naming the offending option.

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

Defined in: [store/store.ts:106](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L106)

Execute a batch of operations and return their results in operation
order.

Accepts: `operations` — an array of operation objects, in the order they
are to be observed; an empty batch does nothing and returns `[]`. `get`,
`put`, `delete` and `listNamespaces` build their operation and send it
here, as upstream's implementations do: `get` and
`delete` check nothing first, `listNamespaces` checks only its options
object, and `put` checks only what is about the method (upstream's `.` and
`"langgraph"` namespace rules, and a `null` value). Every other rule is
checked here, where LangGraph's own calls arrive too.

Returns: the results in operation order — an item or `null` for a get,
matches for a search, namespaces for a listing, nothing for a put.

Throws: ValidationError, raised for every operation before any operation
runs, naming `operations` for a value that is not an array or an entry that
is not an object; `namespace`, `namespace element`, `key` or `sortKey` for an
item address; `value` or `index` for a put; `namespacePrefix`,
`namespacePrefix element`, `filter`, `query`, `offset` or `limit` for a
search; `offset`, `limit`, `maxDepth`, `matchConditions`, `prefix`,
`prefix element`, `suffix` or `suffix element` for a listing; and later,
from a running operation, `value` for one JSON cannot represent,
`maxSearchCandidates` or `index.dims`. UpstreamError; RetryExhaustedError;
ResultTruncatedError from a search or a listing that reads past
`maxScanItems`. One failing operation rejects the whole batch.

Guarantees: the order the caller wrote is the order the caller observes — a
get after a put of the same item sees it, a get before one does not, and a
search sees every write that precedes it and none that follow. Operations
addressing different items run concurrently, so a batch of ten gets costs
about one round trip rather than ten (see `runBatch`).

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

Defined in: [store/store.ts:179](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L179)

Remove one item, as upstream does: a put operation carrying `null`.

Accepts: `namespace` and `key` — as [get](#get).

Returns: nothing. Deleting an item that is not there is not an error.

Throws: ValidationError naming `namespace`, `namespace element`, `key` or
`sortKey`; UpstreamError; RetryExhaustedError.

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

Defined in: [store/store.ts:296](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L296)

Release owned resources.

Accepts: nothing.

Returns: nothing. Idempotent, and a no-op for a client the caller injected
— that one is theirs to close.

Throws: nothing this adapter raises.

#### Returns

`void`

***

### ensureS3LifecycleRule()

> **ensureS3LifecycleRule**(): `Promise`\<`void`\>

Defined in: [store/store.ts:318](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L318)

Provision an S3 lifecycle expiration rule matching the configured TTL, so
offloaded objects don't outlive their DynamoDB item forever.

Accepts: nothing; the rule follows the configured `s3` and `ttl`. A no-op
without both.

Returns: nothing. Installing a rule that is already there is a no-op too,
so calling it on every deploy is safe.

Throws: ValidationError naming `s3.keyPrefix` on a rule-id collision;
UpstreamError when the bucket's lifecycle cannot be read or written.

#### Returns

`Promise`\<`void`\>

#### Remarks

Requires the bucket-level `s3:GetLifecycleConfiguration` /
`s3:PutLifecycleConfiguration` permissions, broader than the object-level
CRUD the rest of S3 offload needs — call it once during provisioning, not
per request.

***

### get()

> **get**(`namespace`, `key`): `Promise`\<`Item` \| `null`\>

Defined in: [store/store.ts:136](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L136)

Retrieve one item. Overrides the base implementation so the call is
guarded here; the operation is the one upstream builds.

Accepts: `namespace` — at least one label, each a non-blank identifier of
at most 256 bytes, free of `#` and control characters and well-formed
UTF-16. A `.` and a `"langgraph"` root are accepted, as the reference store
accepts them. `key` — an identifier by the same rules. Together they may
compose a sort key of at most 1024 bytes.

Returns: the item, or `null` for one that does not exist or has expired.

Throws: ValidationError naming `namespace`, `namespace element`, `key` or
`sortKey`; `FORMAT_UNSUPPORTED` for an item written by a newer version,
which is reported rather than hidden as absent; `PAYLOAD_CORRUPT` for a
payload that cannot be read; AbortError; UpstreamError;
RetryExhaustedError.

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

Defined in: [store/store.ts:199](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L199)

List the distinct namespaces, sorted, optionally filtered and truncated.

Accepts: `options.prefix`/`suffix` — labels a namespace can hold, where
`'*'` matches any one label. `options.maxDepth` — at least 1.
`options.limit`/`offset` —
non-negative integers, defaulting to 100 and 0.

Returns: at most `limit` namespaces from `offset`.

Throws: ValidationError naming `options`, `options.<key>`, `prefix`,
`prefix element`, `suffix`, `suffix element`, `maxDepth`, `limit` or
`offset`; ResultTruncatedError past `maxScanItems`; UpstreamError.

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

Defined in: [store/store.ts:157](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L157)

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

Throws: ValidationError naming `namespace`, `namespace element`, `key`,
`sortKey`, `value` or `index`; UpstreamError; RetryExhaustedError.

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

Defined in: [store/store.ts:260](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L260)

Repair the configured vector backend against the canonical items under
`namespacePrefix`. A maintenance tool; see the action of the same name.

Accepts: `namespacePrefix` — a non-empty namespace. `options.signal` —
aborts between pages.

Returns: how many vectors were upserted and how many pruned.

Throws: ValidationError without both an `index` and a `vectorBackend`, for
an empty prefix, for an invalid `signal`, or for `options.<key>` naming a
key this package does not read; ResultTruncatedError past `maxScanItems`;
UpstreamError.

Guarantees: DynamoDB is never written — only the backend is repaired — and
a vector is deleted only on evidence that its item is gone.

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

Defined in: [store/store.ts:229](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L229)

Search with optional cancellation. Overrides the base implementation, which
routes through [batch](#batch) and therefore cannot carry a signal.

Accepts: `namespacePrefix` — labels a namespace can hold; empty spans the
whole table. `options.query` —
absent or empty ranks nothing. `options.filter` — metadata equality on the
item's value. `options.offset`/`limit` — non-negative integers, defaulting
to 0 and 10. `options.signal` — aborts the reads.

Returns: at most `limit` items from `offset`, each carrying a `score` when
a query and an index are configured.

Throws: ValidationError naming `namespacePrefix`, `namespacePrefix element`,
`filter`, `query`, `offset`, `limit`, `maxSearchCandidates`, `index.dims`,
`signal`, or
`options.<key>` for a key this package does not read; AbortError;
UpstreamError.

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

Defined in: [store/store.ts:282](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L282)

LangGraph's lifecycle hook.

Accepts: nothing.

Returns: nothing. A host that manages stores through the upstream
`BaseStore` interface calls `stop()`, so it releases the owned client
exactly like [destroy](#destroy), which stays the explicit API. Both are
idempotent.

Throws: nothing this adapter raises.

#### Returns

`void`

#### Overrides

`BaseStore.stop`
