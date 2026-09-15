[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBStore

# Class: DynamoDBStore

Defined in: [store/store.ts:32](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L32)

DynamoDB-backed LangGraph store for long-term memory with optional semantic
search. A thin orchestrator: the base class's get/put/search/delete/
listNamespaces all funnel into [batch](#batch), which dispatches each operation.

## Extends

- `BaseStore`

## Constructors

### Constructor

> **new DynamoDBStore**(`options`): `DynamoDBStore`

Defined in: [store/store.ts:50](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L50)

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

Defined in: [store/store.ts:87](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L87)

Execute a batch of operations and return their results in operation
order.

Accepts: `operations` — in the order they are to be observed; an empty
batch does nothing. Every `BaseStore` method (`get`/`put`/`delete`/
`search`/`listNamespaces`) funnels through here, so this is the library's
error boundary for all of them.

Returns: the results in operation order — an item or `null` for a get,
matches for a search, namespaces for a listing, nothing for a put.

Throws: ValidationError for a malformed namespace, key or value;
UpstreamError; RetryExhaustedError; ResultTruncatedError from a listing
over its cap. One failing operation rejects the whole batch.

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

### destroy()

> **destroy**(): `void`

Defined in: [store/store.ts:178](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L178)

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

Defined in: [store/store.ts:200](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L200)

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

### reconcileVectorIndex()

> **reconcileVectorIndex**(`namespacePrefix`, `options?`): `Promise`\<[`VectorReconcileResult`](../interfaces/VectorReconcileResult.md)\>

Defined in: [store/store.ts:143](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L143)

Repair the configured vector backend against the canonical items under
`namespacePrefix`. A maintenance tool; see the action of the same name.

Accepts: `namespacePrefix` — a non-empty namespace. `options.signal` —
aborts between pages.

Returns: how many vectors were upserted and how many pruned.

Throws: ValidationError without both an `index` and a `vectorBackend`, or
for an empty prefix; ResultTruncatedError past `maxScanItems`;
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

Defined in: [store/store.ts:117](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L117)

Search with optional cancellation. Overrides the base implementation, which
routes through [batch](#batch) and therefore cannot carry a signal.

Accepts: `namespacePrefix` — empty spans the whole table. `options.query` —
absent or empty ranks nothing. `options.filter` — metadata equality on the
item's value. `options.offset`/`limit` — non-negative integers, defaulting
to 0 and 10. `options.signal` — aborts the reads.

Returns: at most `limit` items from `offset`, each carrying a `score` when
a query and an index are configured.

Throws: ValidationError naming `offset`, `limit`, `maxSearchCandidates` or
`index.dims`; AbortError; UpstreamError.

Guarantees: a plain search stops reading once `offset + limit` matches are
in hand; a query ranks in-process up to `maxSearchCandidates`, or through
the `vectorBackend` when one is configured.

#### Parameters

##### namespacePrefix

`string`[]

##### options?

`Pick`\<`SearchOperation`, `"filter"` \| `"limit"` \| `"offset"` \| `"query"`\> & [`CancelOptions`](../interfaces/CancelOptions.md) = `{}`

#### Returns

`Promise`\<`SearchItem`[]\>

#### Overrides

`BaseStore.search`

***

### stop()

> **stop**(): `void`

Defined in: [store/store.ts:164](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L164)

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
