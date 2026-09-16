[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBSaver

# Class: DynamoDBSaver

Defined in: [checkpointer/saver.ts:36](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L36)

DynamoDB-backed LangGraph checkpoint saver. A thin orchestrator: it resolves
its collaborators once and delegates every operation to a focused action.
Every public method is the library's error boundary — a raw AWS SDK error
escaping an action surfaces as an `UpstreamError`.

## Extends

- `BaseCheckpointSaver`

## Constructors

### Constructor

> **new DynamoDBSaver**(`options`): `DynamoDBSaver`

Defined in: [checkpointer/saver.ts:55](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L55)

Accepts: `options` — validated here, so a misconfiguration surfaces at
construction rather than on the first request. `options.serde` reaches the
base class, which is why the resolved `this.serde` is what the context
gets.

Returns: a saver that owns the client it built, or borrows the one it was
given.

Throws: ValidationError naming the offending option.

Guarantees: no I/O. Constructing a saver issues no request, so it is safe
at module scope and in a Lambda's init phase.

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

Defined in: [checkpointer/saver.ts:209](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L209)

Delete every checkpoint, payload and pending write of a thread.

Accepts: `threadId` — validated. `options.signal` — aborts between pages.

Returns: nothing. Deleting a thread that does not exist is not an error.

Throws: ValidationError naming `options` for options that are not an
object, `options.<key>` for a key this package does not read, `signal`
for a signal that is not `AbortSignal`-shaped, or `thread_id` for a
malformed `threadId`;
BatchWriteAllIncompleteError when a delete batch does not fully drain,
carrying what did succeed; UpstreamError; AbortError.

Guarantees: a row this adapter did not write is left in place and logged.
Single pass: call it when the thread is quiescent, since a checkpoint
written while it runs may survive it.

#### Parameters

##### threadId

`string`

##### options?

[`CancelOptions`](../interfaces/CancelOptions.md)

#### Returns

`Promise`\<`void`\>

#### Overrides

`BaseCheckpointSaver.deleteThread`

***

### destroy()

> **destroy**(): `void`

Defined in: [checkpointer/saver.ts:275](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L275)

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

Defined in: [checkpointer/saver.ts:298](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L298)

Provision an S3 lifecycle expiration rule matching the configured TTL, so
offloaded payloads don't outlive the items that point at them.

Accepts: nothing; the rule follows the configured `s3` and `ttl`. A no-op
without both, since there would be no bucket to rule over or no expiry to
match.

Returns: nothing. Installing a rule that is already there is a no-op too,
so calling it on every deploy is safe.

Throws: ValidationError naming `s3.keyPrefix` on a rule-id collision;
UpstreamError when the bucket's lifecycle cannot be read or written.

#### Returns

`Promise`\<`void`\>

#### Remarks

Needs the bucket-level `s3:GetLifecycleConfiguration` and
`s3:PutLifecycleConfiguration` permissions, which are broader than the
object-level CRUD the rest of S3 offload needs. Call it once at deployment,
not per request.

***

### getDeltaChannelHistory()

> **getDeltaChannelHistory**(`options`): `Promise`\<`Record`\<`string`, `DeltaChannelHistory`\>\>

Defined in: [checkpointer/saver.ts:249](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L249)

Walk a checkpoint's ancestors for the delta channels named, returning each
channel's on-path writes oldest-first and its nearest stored value.

Overrides the inherited walk, which stops silently at an ancestor it cannot
read and lets the consumer restart the channel from empty. A TTL computed
per put puts that within reach here, so an ancestor a channel still needs
that has expired is reported instead of dropped; see `deltaChannelHistory`.

Accepts: `options` — must be an object naming exactly `config` and
`channels`, the shape `BaseCheckpointSaver`'s own signature declares.
`options.channels` — the delta channels to rebuild, required; an empty
array reads nothing rather than being refused, since it is a legitimate
"nothing to rebuild" request. `options.config` — the checkpoint to walk
back from, shaped as [getTuple](#gettuple) requires and checked for that shape
even when there is nothing to read; its `signal` aborts the read of that
checkpoint.

Returns: per channel, its on-path writes oldest-first and the nearest
stored value found.

Throws: ValidationError naming `options` for options that are not an
object, `options.<key>` for an unknown key, `config`, `configurable` or
`signal` for a config of the wrong shape, or `channels` for a value that
is not an array of strings, and, once a channel is named, `thread_id`,
`checkpoint_ns`, `checkpoint_id` or `thread_ts` for a malformed
identifier; `ANCESTOR_EXPIRED` when a checkpoint a channel still needs has
expired; UpstreamError; RetryExhaustedError; AbortError.

Guarantees: the walk stops at the first ancestor answering for every
channel, so a deep thread costs reads only as far back as the nearest
snapshot.

#### Parameters

##### options

[`DeltaChannelHistoryOptions`](../interfaces/DeltaChannelHistoryOptions.md)

#### Returns

`Promise`\<`Record`\<`string`, `DeltaChannelHistory`\>\>

#### Overrides

`BaseCheckpointSaver.getDeltaChannelHistory`

***

### getTuple()

> **getTuple**(`config`): `Promise`\<`CheckpointTuple` \| `undefined`\>

Defined in: [checkpointer/saver.ts:87](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L87)

Read one checkpoint with its metadata and pending writes.

Accepts: `config` — an object; `config.configurable`, when present, an
object too. `config.configurable.checkpoint_id` — names the checkpoint, and
`thread_ts` is read in its place when it is absent; the absence of both
asks for the newest in the namespace. `checkpoint_ns` defaults to the root
namespace. A config naming no `thread_id` is accepted: its other
identifiers are still validated. `config.signal` — aborts the reads.

Returns: the tuple, or `undefined` for an unknown thread, an unknown
checkpoint, a config naming no thread, or a checkpoint whose payload row is
not there yet.

Throws: ValidationError, before any read, naming `config` for a config that
is not an object, `configurable` for a `configurable` that is present and
not an object, `signal` for a signal that is not `AbortSignal`-shaped, or
`thread_id`, `checkpoint_ns`, `checkpoint_id` or `thread_ts` for a
malformed identifier; `FORMAT_UNSUPPORTED` for a row a newer release wrote;
UpstreamError; RetryExhaustedError; AbortError.

Guarantees: strongly consistent, so a checkpoint just written is always
seen.

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

Defined in: [checkpointer/saver.ts:119](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L119)

Stream checkpoints newest first.

Accepts: `config` — one namespace, every namespace of a thread when
`checkpoint_ns` is omitted, or every thread in the table when `thread_id`
is omitted, which is a table scan. `options.before`, `options.filter` and
`options.limit` follow the reference savers; a limit of 0 or less yields
nothing.

Returns: an async generator over the tuples. Abandoning it stops the read,
so a consumer that breaks early pays for no further page.

Throws: ValidationError, raised from the first `.next()`, since a
generator runs none of its body until pulled, and before any read: naming
`config`, `configurable` or `signal` for a config of the wrong shape, as
[getTuple](#gettuple) does, or `thread_id`, `checkpoint_ns`, `checkpoint_id` or
`thread_ts` for a malformed identifier — all checked before `options`;
then `options` for options that are not an object, `options.<key>` for a
key this package does not read, `filter` for a filter that is not an
object, `limit` for a limit that is not an integer, and `before` for a
`before` that is not an object or whose `configurable.checkpoint_id` is
neither absent (`undefined`, `null` or `''`) nor a well-formed checkpoint
id. `FORMAT_UNSUPPORTED`; UpstreamError; RetryExhaustedError; AbortError.

Guarantees: eventually consistent — a listing tolerates the replica lag
`getTuple` does not.

#### Parameters

##### config

`RunnableConfig`

##### options?

`CheckpointListOptions`

#### Returns

`AsyncGenerator`\<`CheckpointTuple`\>

#### Remarks

One read per page plus two per yielded tuple (see the README cost table).

#### Overrides

`BaseCheckpointSaver.list`

***

### put()

> **put**(`config`, `checkpoint`, `metadata`, `newVersions?`): `Promise`\<`RunnableConfig`\<`Record`\<`string`, `any`\>\>\>

Defined in: [checkpointer/saver.ts:148](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L148)

Store a checkpoint and its metadata in one transaction.

Accepts: `config` — shaped as [getTuple](#gettuple) requires, and naming a
`thread_id`. `config.configurable.checkpoint_id` — becomes the new
checkpoint's parent. `config.signal` — aborts the write. `checkpoint` —
every channel value it carries is stored. `newVersions` — accepted to
satisfy `BaseCheckpointSaver.put` and deliberately ignored; see
`putCheckpoint` for why narrowing by it lost state on a fork.

Returns: the config addressing the stored checkpoint, which is what the
caller passes back to continue the thread.

Throws: ValidationError naming `config`, `configurable` or `signal` for a
config of the wrong shape, `thread_id` for a missing or malformed thread
id, `checkpoint_ns`, `checkpoint_id` or `thread_ts` for a malformed
identifier, `checkpoint` for a `null` or `undefined` checkpoint,
`checkpoint_id` for a malformed `checkpoint.id`, `payload` for a payload
too large to store inline without `s3`, or `s3Key` for an offloaded
object's key over S3's cap; `S3_OFFLOAD_FAILED` when an offloaded payload
cannot be uploaded; UpstreamError; RetryExhaustedError; AbortError.

Guarantees: both rows land or neither does. Writing the same
`checkpoint.id` again replaces both, so a retry is safe.

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

#### Overrides

`BaseCheckpointSaver.put`

***

### putWrites()

> **putWrites**(`config`, `writes`, `taskId`): `Promise`\<`void`\>

Defined in: [checkpointer/saver.ts:185](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L185)

Store a task's pending writes for the checkpoint `config` names.

Accepts: `config` — shaped as [getTuple](#gettuple) requires, naming a
`thread_id` and a `checkpoint_id`, since writes attach to a checkpoint.
`config.signal` — aborts the writes. `writes` — an array of
`[channel, value]` arrays, one row each, written in parallel; an empty list
writes nothing. `taskId` — validated as the key segment it becomes.

Returns: nothing. Losing a first-write-wins race is a normal outcome, not
a failure.

Throws: ValidationError naming `taskId` for a malformed task id; `config`,
`configurable` or `signal` for a config of the wrong shape; `thread_id`,
`checkpoint_ns`, `checkpoint_id` or `thread_ts` for a malformed
identifier, and `checkpoint_id` when the config names none; `writes` for
writes that is not an array, or holds an entry that is not one; `channel`
for a malformed channel; `sortKey` for identifiers composing a sort key
over DynamoDB's cap; `payload` for a value too large to store inline
without `s3`; or `s3Key` for an offloaded object's key over S3's cap.
`S3_OFFLOAD_FAILED`; UpstreamError; RetryExhaustedError; AbortError.

Guarantees: regular writes are first-write-wins; special channels
(`__interrupt__`, `__resume__`, `__error__`, `__scheduled__`) overwrite,
guarded so two concurrent calls never orphan an offloaded object.

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
