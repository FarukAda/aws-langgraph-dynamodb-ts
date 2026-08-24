[**AWS LangGraph DynamoDB TypeScript v0.3.1**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / VectorBackend

# Interface: VectorBackend

Defined in: [store/vector-backend.ts:18](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/store/vector-backend.ts#L18)

Pluggable vector index. When provided to the store, embeddings live here and
similarity search is delegated to it; DynamoDB still holds the canonical item.

## Methods

### delete()

> **delete**(`namespace`, `key`): `Promise`\<`void`\>

Defined in: [store/vector-backend.ts:21](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/store/vector-backend.ts#L21)

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

Defined in: [store/vector-backend.ts:27](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/store/vector-backend.ts#L27)

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

Defined in: [store/vector-backend.ts:20](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/store/vector-backend.ts#L20)

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

Defined in: [store/vector-backend.ts:19](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/da0c0394d9d0bb7780d9d583c3a463c945bbaeb3/src/store/vector-backend.ts#L19)

#### Parameters

##### namespace

`string`[]

##### key

`string`

##### vector

`number`[]

#### Returns

`Promise`\<`void`\>
