[**AWS LangGraph DynamoDB TypeScript v0.8.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBStore

# Class: DynamoDBStore

Defined in: [store/store.ts:28](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/5a137c4668c089acbdd8dcb66b61b636923c4718/src/store/store.ts#L28)

DynamoDB-backed LangGraph store for long-term memory with optional semantic
search. A thin orchestrator: the base class's get/put/search/delete/
listNamespaces all funnel into [batch](#batch), which dispatches each operation.

## Extends

- `BaseStore`

## Constructors

### Constructor

> **new DynamoDBStore**(`options`): `DynamoDBStore`

Defined in: [store/store.ts:33](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/5a137c4668c089acbdd8dcb66b61b636923c4718/src/store/store.ts#L33)

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

Defined in: [store/store.ts:48](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/5a137c4668c089acbdd8dcb66b61b636923c4718/src/store/store.ts#L48)

Execute multiple operations in a single batch.
This is more efficient than executing operations individually.

#### Type Parameters

##### Op

`Op` *extends* `Operation`[]

#### Parameters

##### operations

`Op`

Array of operations to execute

#### Returns

`Promise`\<`OperationResults`\<`Op`\>\>

Promise resolving to results matching the operations

#### Overrides

`BaseStore.batch`

***

### destroy()

> **destroy**(): `void`

Defined in: [store/store.ts:65](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/5a137c4668c089acbdd8dcb66b61b636923c4718/src/store/store.ts#L65)

Release owned resources (the underlying client and any S3 client).

#### Returns

`void`

***

### ensureS3LifecycleRule()

> **ensureS3LifecycleRule**(): `Promise`\<`void`\>

Defined in: [store/store.ts:78](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/5a137c4668c089acbdd8dcb66b61b636923c4718/src/store/store.ts#L78)

Best-effort provision an S3 lifecycle expiration rule matching the
configured TTL, so offloaded objects don't outlive their DynamoDB item
forever. No-ops when S3 offload or TTL isn't configured. Requires the
`s3:GetLifecycleConfiguration`/`s3:PutLifecycleConfiguration` bucket-level
permissions (broader than the object-level CRUD the rest of S3 offload
needs) — call this once during deployment/provisioning, not per-request.

#### Returns

`Promise`\<`void`\>

***

### reconcileVectorIndex()

> **reconcileVectorIndex**(`namespacePrefix`): `Promise`\<[`VectorReconcileResult`](../interfaces/VectorReconcileResult.md)\>

Defined in: [store/store.ts:60](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/5a137c4668c089acbdd8dcb66b61b636923c4718/src/store/store.ts#L60)

Repair the configured vector backend against the canonical items under
`namespacePrefix`. A maintenance tool; see [reconcileVectorIndex](#reconcilevectorindex).

#### Parameters

##### namespacePrefix

`string`[]

#### Returns

`Promise`\<[`VectorReconcileResult`](../interfaces/VectorReconcileResult.md)\>
