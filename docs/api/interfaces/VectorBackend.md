[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / VectorBackend

# Interface: VectorBackend

Defined in: [store/vector-backend.ts:37](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/vector-backend.ts#L37)

Pluggable vector index. When provided to the store, embeddings live here and
similarity search is delegated to it; DynamoDB still holds the canonical item.

This is an interface you implement, so what the store promises and what it
requires are both stated per method. Two properties hold throughout: the
store writes DynamoDB first and syncs here afterwards, so the backend may lag
the canonical item and `reconcileVectorIndex` exists to close that gap; and
every result is re-read from DynamoDB before a caller sees it, so a stale
entry costs a wasted read, never a wrong answer.

## Methods

### delete()

> **delete**(`namespace`, `key`): `Promise`\<`void`\>

Defined in: [store/vector-backend.ts:79](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/vector-backend.ts#L79)

Drop one item's vector.

Receives: the item's address. Called when the item is deleted, and also
after any put that produced no vector — `index: false`, or a value with no
indexable text — because the previous vector would otherwise keep matching
an item that no longer has that text.

Must: succeed for a key that holds no vector. That is the common case on
the no-vector put path, and treating it as an error would warn on every
such put.

#### Parameters

##### namespace

`string`[]

##### key

`string`

#### Returns

`Promise`\<`void`\>

***

### listKeys()?

> `optional` **listKeys**(`namespacePrefix`): `Promise`\<[`VectorRef`](VectorRef.md)[]\>

Defined in: [store/vector-backend.ts:89](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/vector-backend.ts#L89)

Optionally enumerate every stored vector under `namespacePrefix`. Enables
`reconcileVectorIndex` to prune vectors orphaned by a lost delete. Omit it
when the backend cannot enumerate — reconciliation then re-pushes only.

Must: not return keys from outside `namespacePrefix`. Under-reporting only
leaves an orphan for a later reconcile; over-reporting offers a vector
outside the scope for pruning, and the reconcile is what would delete it.

#### Parameters

##### namespacePrefix

`string`[]

#### Returns

`Promise`\<[`VectorRef`](VectorRef.md)[]\>

***

### query()

> **query**(`namespacePrefix`, `queryVector`, `topK`): `Promise`\<[`VectorMatch`](VectorMatch.md)[]\>

Defined in: [store/vector-backend.ts:66](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/vector-backend.ts#L66)

Return up to `topK` matches under `namespacePrefix`, best first.

Receives: the same query vector width as `upsert`, and a `topK` the store
raises — up to `maxSearchCandidates` — while its filter leaves the page
short, so returning fewer than `topK` is read as "that is all there is".

Must: order best-first, and score each match as a relevance, not a
distance (see [VectorMatch.score](VectorMatch.md#score)). Matches outside the prefix, and
matches whose item has since been deleted, are dropped by the store rather
than trusted — over-returning is safe, under-returning silently shortens
the page.

#### Parameters

##### namespacePrefix

`string`[]

##### queryVector

`number`[]

##### topK

`number`

#### Returns

`Promise`\<[`VectorMatch`](VectorMatch.md)[]\>

***

### upsert()

> **upsert**(`namespace`, `key`, `vector`): `Promise`\<`void`\>

Defined in: [store/vector-backend.ts:52](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/vector-backend.ts#L52)

Store one item's vector.

Receives: a validated `namespace` and `key`, and a vector of the width
`index.dims` declares. Called once per indexed put, after the item is
committed, and again for every item of a `reconcileVectorIndex`.

Must: replace any vector already held for that `(namespace, key)` —
upserting the same pair repeatedly is normal and must not accumulate
entries.

May throw: a rejection is logged and swallowed on the put path (the item
still stands) and propagates from a reconcile.

#### Parameters

##### namespace

`string`[]

##### key

`string`

##### vector

`number`[]

#### Returns

`Promise`\<`void`\>
