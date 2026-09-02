[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBSaver

# Class: DynamoDBSaver

Defined in: [checkpointer/saver.ts:29](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L29)

DynamoDB-backed LangGraph checkpoint saver. A thin orchestrator: it resolves
its collaborators once and delegates every operation to a focused action.
Every public method is the library's error boundary — a raw AWS SDK error
escaping an action surfaces as an `UpstreamError`.

## Extends

- `BaseCheckpointSaver`

## Constructors

### Constructor

> **new DynamoDBSaver**(`options`): `DynamoDBSaver`

Defined in: [checkpointer/saver.ts:34](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L34)

#### Parameters

##### options

[`DynamoDBSaverOptions`](../type-aliases/DynamoDBSaverOptions.md)

#### Returns

`DynamoDBSaver`

#### Overrides

`BaseCheckpointSaver.constructor`

## Methods

### deleteThread()

> **deleteThread**(`threadId`, `options?`): `Promise`\<`void`\>

Defined in: [checkpointer/saver.ts:104](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L104)

Delete every checkpoint, payload and pending write of a thread and their
offloaded objects. Single pass: call it when the thread is quiescent.

#### Parameters

##### threadId

`string`

##### options?

[`CancelOptions`](../interfaces/CancelOptions.md)

#### Returns

`Promise`\<`void`\>

#### Throws

BatchWriteAllIncompleteError when a delete batch does not fully drain; UpstreamError; AbortError (`options.signal`).

#### Overrides

`BaseCheckpointSaver.deleteThread`

***

### destroy()

> **destroy**(): `void`

Defined in: [checkpointer/saver.ts:111](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L111)

Release owned resources (the underlying client and any S3 client).

#### Returns

`void`

***

### ensureS3LifecycleRule()

> **ensureS3LifecycleRule**(): `Promise`\<`void`\>

Defined in: [checkpointer/saver.ts:125](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L125)

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

### getTuple()

> **getTuple**(`config`): `Promise`\<`CheckpointTuple` \| `undefined`\>

Defined in: [checkpointer/saver.ts:50](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L50)

Read one checkpoint with its metadata and pending writes: the one
`checkpoint_id` names, else the newest in the namespace. Strongly
consistent, so a checkpoint just written is always seen. Returns
`undefined` for an unknown thread or checkpoint, or a config without a
thread.

#### Parameters

##### config

`RunnableConfig`

#### Returns

`Promise`\<`CheckpointTuple` \| `undefined`\>

#### Throws

ValidationError for a malformed identifier; UpstreamError, RetryExhaustedError, AbortError (`config.signal`).

#### Overrides

`BaseCheckpointSaver.getTuple`

***

### list()

> **list**(`config`, `options?`): `AsyncGenerator`\<`CheckpointTuple`\>

Defined in: [checkpointer/saver.ts:62](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L62)

Stream checkpoints newest first: one namespace, every namespace of a
thread when `checkpoint_ns` is omitted, or every thread in the table when
`thread_id` is omitted (a table scan). Eventually consistent. `before`,
`filter` and `limit` follow the reference savers.

#### Parameters

##### config

`RunnableConfig`

##### options?

`CheckpointListOptions`

#### Returns

`AsyncGenerator`\<`CheckpointTuple`\>

#### Remarks

One read per page plus two per yielded tuple (see the README cost table).

#### Throws

ValidationError, UpstreamError, RetryExhaustedError, AbortError.

#### Overrides

`BaseCheckpointSaver.list`

***

### put()

> **put**(`config`, `checkpoint`, `metadata`, `newVersions?`): `Promise`\<`RunnableConfig`\<`Record`\<`string`, `any`\>\>\>

Defined in: [checkpointer/saver.ts:74](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L74)

Store a checkpoint and its metadata in one transaction and return the
config that addresses it. `config.checkpoint_id` becomes the parent;
`newVersions` names the channels that changed, and only those plus the
ones the parent stored are persisted. Last writer wins for a repeated
`checkpoint_id`.

#### Parameters

##### config

`RunnableConfig`

##### checkpoint

`Checkpoint`

##### metadata

`CheckpointMetadata`

##### newVersions?

`ChannelVersions`

#### Returns

`Promise`\<`RunnableConfig`\<`Record`\<`string`, `any`\>\>\>

#### Throws

ValidationError; UpstreamError; RetryExhaustedError; AbortError; S3_OFFLOAD_FAILED when an offloaded payload cannot be uploaded.

#### Overrides

`BaseCheckpointSaver.put`

***

### putWrites()

> **putWrites**(`config`, `writes`, `taskId`): `Promise`\<`void`\>

Defined in: [checkpointer/saver.ts:93](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L93)

Store a task's pending writes for the checkpoint `config` names, one row
per write, written in parallel. Regular writes are first-write-wins;
special channels (`__interrupt__`, `__resume__`, `__error__`,
`__scheduled__`) overwrite, guarded so two concurrent calls never orphan
an offloaded object.

#### Parameters

##### config

`RunnableConfig`

##### writes

`PendingWrite`[]

##### taskId

`string`

#### Returns

`Promise`\<`void`\>

#### Throws

ValidationError when `checkpoint_id` is missing or a channel is malformed; UpstreamError; RetryExhaustedError; AbortError.

#### Overrides

`BaseCheckpointSaver.putWrites`
