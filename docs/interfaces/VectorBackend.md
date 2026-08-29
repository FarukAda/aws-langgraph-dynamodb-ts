[**AWS LangGraph DynamoDB TypeScript v0.8.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / VectorBackend

# Interface: VectorBackend

Defined in: [store/vector-backend.ts:30](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/764a36f34f1f6210c41e72e5aa36bf1198e2d7c2/src/store/vector-backend.ts#L30)

Pluggable vector index. When provided to the store, embeddings live here and
similarity search is delegated to it; DynamoDB still holds the canonical item.

## Methods

### delete()

> **delete**(`namespace`, `key`): `Promise`\<`void`\>

Defined in: [store/vector-backend.ts:38](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/764a36f34f1f6210c41e72e5aa36bf1198e2d7c2/src/store/vector-backend.ts#L38)

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

Defined in: [store/vector-backend.ts:44](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/764a36f34f1f6210c41e72e5aa36bf1198e2d7c2/src/store/vector-backend.ts#L44)

Optionally enumerate every stored vector under `namespacePrefix`. Enables
`reconcileVectorIndex` to prune vectors orphaned by a lost delete. Omit it
when the backend cannot enumerate — reconciliation then re-pushes only.

#### Parameters

##### namespacePrefix

`string`[]

#### Returns

`Promise`\<[`VectorRef`](VectorRef.md)[]\>

***

### query()

> **query**(`namespacePrefix`, `queryVector`, `topK`): `Promise`\<[`VectorMatch`](VectorMatch.md)[]\>

Defined in: [store/vector-backend.ts:37](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/764a36f34f1f6210c41e72e5aa36bf1198e2d7c2/src/store/vector-backend.ts#L37)

Return up to `topK` matches under `namespacePrefix`, best first. Each
match's `score` must be a relevance, not a distance — see
[VectorMatch.score](VectorMatch.md#score).

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

Defined in: [store/vector-backend.ts:31](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/764a36f34f1f6210c41e72e5aa36bf1198e2d7c2/src/store/vector-backend.ts#L31)

#### Parameters

##### namespace

`string`[]

##### key

`string`

##### vector

`number`[]

#### Returns

`Promise`\<`void`\>
