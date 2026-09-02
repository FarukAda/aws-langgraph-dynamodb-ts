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

Defined in: [store/store.ts:37](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L37)

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

Defined in: [store/store.ts:63](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L63)

Execute a batch of operations and return their results in operation
order. Writes to one item stay ordered; writes to different items, and
then all reads, run concurrently — so a get after a put to the same key
in one batch observes the put, and a batch of ten gets costs about one
round trip rather than ten (see `runBatch`). The library's error boundary
for every `BaseStore` method (`get`/`put`/`delete`/`search`/
`listNamespaces` all funnel through here): a raw AWS SDK error surfaces
as an `UpstreamError`, and one failing operation rejects the whole batch.

#### Type Parameters

##### Op

`Op` *extends* `Operation`[]

#### Parameters

##### operations

`Op`

#### Returns

`Promise`\<`OperationResults`\<`Op`\>\>

#### Throws

ValidationError for a malformed namespace, key or value; UpstreamError; RetryExhaustedError; ResultTruncatedError from a listing over its cap.

#### Overrides

`BaseStore.batch`

***

### destroy()

> **destroy**(): `void`

Defined in: [store/store.ts:112](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L112)

Release owned resources (the underlying client and any S3 client).

#### Returns

`void`

***

### ensureS3LifecycleRule()

> **ensureS3LifecycleRule**(): `Promise`\<`void`\>

Defined in: [store/store.ts:126](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L126)

Provision an S3 lifecycle expiration rule matching the configured TTL, so
offloaded objects don't outlive their DynamoDB item forever. No-ops when
S3 offload or TTL isn't configured; throws when the bucket cannot be read
or written. Requires the `s3:GetLifecycleConfiguration` /
`s3:PutLifecycleConfiguration` bucket-level permissions (broader than the
object-level CRUD the rest of S3 offload needs) — call this once during
deployment/provisioning, not per-request.

#### Returns

`Promise`\<`void`\>

***

### reconcileVectorIndex()

> **reconcileVectorIndex**(`namespacePrefix`, `options?`): `Promise`\<[`VectorReconcileResult`](../interfaces/VectorReconcileResult.md)\>

Defined in: [store/store.ts:92](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L92)

Repair the configured vector backend against the canonical items under
`namespacePrefix`. A maintenance tool; see [reconcileVectorIndex](#reconcilevectorindex).

#### Parameters

##### namespacePrefix

`string`[]

##### options?

[`CancelOptions`](../interfaces/CancelOptions.md)

#### Returns

`Promise`\<[`VectorReconcileResult`](../interfaces/VectorReconcileResult.md)\>

#### Throws

ValidationError without an `index` and `vectorBackend` or for an empty prefix; ResultTruncatedError past `maxScanItems`.

***

### search()

> **search**(`namespacePrefix`, `options?`): `Promise`\<`SearchItem`[]\>

Defined in: [store/store.ts:77](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L77)

Search with optional cancellation. Overrides the base implementation, which
routes through [batch](#batch) and therefore cannot carry a signal. A plain
search stops reading once `offset + limit` matches are in hand; a `query`
ranks in-process (up to `maxSearchCandidates`) or through the `vectorBackend`.

#### Parameters

##### namespacePrefix

`string`[]

##### options?

`Pick`\<`SearchOperation`, `"filter"` \| `"limit"` \| `"offset"` \| `"query"`\> & [`CancelOptions`](../interfaces/CancelOptions.md) = `{}`

#### Returns

`Promise`\<`SearchItem`[]\>

#### Throws

ValidationError when the candidate set exceeds `maxSearchCandidates`; AbortError; UpstreamError.

#### Overrides

`BaseStore.search`

***

### stop()

> **stop**(): `void`

Defined in: [store/store.ts:107](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/store.ts#L107)

LangGraph's lifecycle hook. A host that manages stores through the
upstream `BaseStore` interface calls `stop()`, so it releases the owned
client exactly like [destroy](#destroy), which stays the explicit API. Both
are idempotent.

#### Returns

`void`

#### Overrides

`BaseStore.stop`
