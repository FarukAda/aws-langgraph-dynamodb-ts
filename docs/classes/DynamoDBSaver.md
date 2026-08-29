[**AWS LangGraph DynamoDB TypeScript v0.8.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBSaver

# Class: DynamoDBSaver

Defined in: [checkpointer/saver.ts:24](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/checkpointer/saver.ts#L24)

DynamoDB-backed LangGraph checkpoint saver. A thin orchestrator: it resolves
its collaborators once and delegates every operation to a focused action.

## Extends

- `BaseCheckpointSaver`

## Constructors

### Constructor

> **new DynamoDBSaver**(`options`): `DynamoDBSaver`

Defined in: [checkpointer/saver.ts:29](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/checkpointer/saver.ts#L29)

#### Parameters

##### options

[`DynamoDBSaverOptions`](../type-aliases/DynamoDBSaverOptions.md)

#### Returns

`DynamoDBSaver`

#### Overrides

`BaseCheckpointSaver.constructor`

## Methods

### deleteThread()

> **deleteThread**(`threadId`): `Promise`\<`void`\>

Defined in: [checkpointer/saver.ts:57](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/checkpointer/saver.ts#L57)

Delete all checkpoints and writes associated with a specific thread ID.

#### Parameters

##### threadId

`string`

The thread ID whose checkpoints should be deleted.

#### Returns

`Promise`\<`void`\>

#### Overrides

`BaseCheckpointSaver.deleteThread`

***

### destroy()

> **destroy**(): `void`

Defined in: [checkpointer/saver.ts:62](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/checkpointer/saver.ts#L62)

Release owned resources (the underlying client and any S3 client).

#### Returns

`void`

***

### ensureS3LifecycleRule()

> **ensureS3LifecycleRule**(): `Promise`\<`void`\>

Defined in: [checkpointer/saver.ts:75](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/checkpointer/saver.ts#L75)

Best-effort provision an S3 lifecycle expiration rule matching the
configured TTL, so offloaded objects don't outlive their DynamoDB item
forever. No-ops when S3 offload or TTL isn't configured. Requires the
`s3:GetLifecycleConfiguration`/`s3:PutLifecycleConfiguration` bucket-level
permissions (broader than the object-level CRUD the rest of S3 offload
needs) — call this once during deployment/provisioning, not per-request.

#### Returns

`Promise`\<`void`\>

***

### getTuple()

> **getTuple**(`config`): `Promise`\<`CheckpointTuple` \| `undefined`\>

Defined in: [checkpointer/saver.ts:37](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/checkpointer/saver.ts#L37)

#### Parameters

##### config

`RunnableConfig`

#### Returns

`Promise`\<`CheckpointTuple` \| `undefined`\>

#### Overrides

`BaseCheckpointSaver.getTuple`

***

### list()

> **list**(`config`, `options?`): `AsyncGenerator`\<`CheckpointTuple`\>

Defined in: [checkpointer/saver.ts:41](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/checkpointer/saver.ts#L41)

#### Parameters

##### config

`RunnableConfig`

##### options?

`CheckpointListOptions`

#### Returns

`AsyncGenerator`\<`CheckpointTuple`\>

#### Overrides

`BaseCheckpointSaver.list`

***

### put()

> **put**(`config`, `checkpoint`, `metadata`): `Promise`\<`RunnableConfig`\<`Record`\<`string`, `any`\>\>\>

Defined in: [checkpointer/saver.ts:45](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/checkpointer/saver.ts#L45)

#### Parameters

##### config

`RunnableConfig`

##### checkpoint

`Checkpoint`

##### metadata

`CheckpointMetadata`

#### Returns

`Promise`\<`RunnableConfig`\<`Record`\<`string`, `any`\>\>\>

#### Overrides

`BaseCheckpointSaver.put`

***

### putWrites()

> **putWrites**(`config`, `writes`, `taskId`): `Promise`\<`void`\>

Defined in: [checkpointer/saver.ts:53](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/ad2e6576ff7a91fa602629f413eed58996e402dd/src/checkpointer/saver.ts#L53)

Store intermediate writes linked to a checkpoint.

#### Parameters

##### config

`RunnableConfig`

##### writes

`PendingWrite`[]

##### taskId

`string`

#### Returns

`Promise`\<`void`\>

#### Overrides

`BaseCheckpointSaver.putWrites`
