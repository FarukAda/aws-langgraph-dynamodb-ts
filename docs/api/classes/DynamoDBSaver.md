[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBSaver

# Class: DynamoDBSaver

Defined in: [checkpointer/saver.ts:47](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L47)

DynamoDB-backed LangGraph checkpoint saver. Every public method rejects only
with this library's error, whose `code` says what failed — an AWS failure
included.

## Extends

- `BaseCheckpointSaver`

## Constructors

### Constructor

> **new DynamoDBSaver**(`options`): `DynamoDBSaver`

Defined in: [checkpointer/saver.ts:65](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L65)

Accepts: `options` — validated here, so a misconfiguration surfaces at
construction rather than on the first request. `options.serde` reaches the
base class, which is why the resolved `this.serde` is what the context
gets.

Returns: a saver that owns the client it built, or borrows the one it was
given.

Throws: `VALIDATION` naming the offending option.

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

Defined in: [checkpointer/saver.ts:267](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L267)

Delete every checkpoint, payload and pending write of a thread.

Accepts: `threadId` — validated. `options.signal` — aborts between pages.

Returns: nothing. Deleting a thread that does not exist is not an error.

Throws: `VALIDATION` naming `options` for options that are not an
object, `options.<key>` for a key this package does not read, `signal`
for a signal that is not `AbortSignal`-shaped, or `thread_id` for a
malformed `threadId`;
`BATCH_WRITE_INCOMPLETE` when a row's delete fails, counting rows
rather than batches and carrying what did succeed; a classified AWS failure;
`ABORTED` when the signal fires, which is what a cancel surfaces as
rather than an incomplete delete, even when it fires part-way through the
pass. A row refused because it was rewritten after the partition read
raises nothing: it is left exactly as its writer left it, reported at
`warn`, and counted as skipped.

Guarantees: a row this adapter did not write is left in place and logged,
and neither is a row rewritten since the read — so an acknowledged write is
no longer erased, nor the object it names released, by a delete that
observed the row before it. Single pass: call it when the thread is
quiescent, since a checkpoint written at a key the read never saw survives
it, and so does the re-landing of an inline pending write, which carries no
request token on purpose. What comes back there is an ordinary row, naming
no object this call could have released.

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

Defined in: [checkpointer/saver.ts:345](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L345)

Release owned resources.

Accepts: nothing.

Returns: nothing. Idempotent, and a no-op for a client the caller injected
— that one is theirs to close.

Throws: the first failure a resource's own `destroy` raised, as a
`DynamoDBLangGraphError` (`UNEXPECTED_ERROR` unless the failure was AWS's)
with it as `cause` — raised only after every other resource has been
released, and only by the first call: `destroy()` is idempotent.

#### Returns

`void`

***

### ensureS3LifecycleRule()

> **ensureS3LifecycleRule**(): `Promise`\<`void`\>

Defined in: [checkpointer/saver.ts:376](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L376)

Provision an S3 lifecycle expiration rule matching the configured TTL, so
offloaded payloads don't outlive the items that point at them.

Accepts: nothing; the rule follows the configured `s3` and `ttl`. A no-op
without both, since there would be no bucket to rule over or no expiry to
match.

Returns: nothing. Installing a rule that is already there is a no-op too,
so calling it on every deploy is safe. When it writes the rules but
cannot confirm within its polling window that a re-read shows them — S3
documents that a lifecycle configuration can take minutes to propagate —
it logs a `warn` and returns rather than throwing: the rules were
written, and a later call can confirm them.

Throws: `VALIDATION` naming `s3.keyPrefix` on a rule-id collision;
a classified AWS failure when the bucket's lifecycle cannot be read or
written; `CONTENTION` when every one of the five rounds this call polls
needs a write — a competing writer replacing the configuration on every
single re-read.

#### Returns

`Promise`\<`void`\>

#### Remarks

Needs the bucket-level `s3:GetLifecycleConfiguration` and
`s3:PutLifecycleConfiguration` permissions, which are broader than the
object-level CRUD the rest of S3 offload needs. Call it once at deployment,
not per request — and when several adapters or processes provision the
same bucket, call them one at a time and run each again after a few
minutes once every one of them has run.

***

### getDeltaChannelHistory()

> **getDeltaChannelHistory**(`options`): `Promise`\<`Record`\<`string`, `DeltaChannelHistory`\>\>

Defined in: [checkpointer/saver.ts:314](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L314)

Walk a checkpoint's ancestors for the delta channels named, returning each
channel's on-path writes oldest-first and its nearest stored value.

Overrides the inherited walk, which stops silently at an ancestor it cannot
read and lets the consumer restart the channel from empty. A TTL computed
per put puts that within reach here, so an ancestor a channel still needs
that has expired is reported instead of dropped.

Accepts: `options` — must be an object naming exactly `config` and
`channels`, the shape `BaseCheckpointSaver`'s own signature declares.
`options.channels` — the delta channels to rebuild, required; an empty
array reads nothing rather than being refused, since it is a legitimate
"nothing to rebuild" request. `options.config` — the checkpoint to walk
back from, shaped as [getTuple](#gettuple) requires and checked for that shape
even when there is nothing to read; its `signal` aborts the whole walk —
every ancestor read, not only the first — and the hop it fires on is the
last read the call makes.

Returns: per channel, its on-path writes oldest-first and the nearest
stored value found.

Throws: `VALIDATION` naming `options` for options that are not an
object, `options.<key>` for an unknown key, `config`, `configurable` or
`signal` for a config of the wrong shape, or `channels` for a value that
is not an array of strings, and, once a channel is named, `thread_id`,
`checkpoint_ns`, `checkpoint_id` or `thread_ts` for a malformed
identifier; `ANCESTOR_EXPIRED` when a checkpoint a channel still needs has
expired; a classified AWS failure; `RETRY_EXHAUSTED`; `ABORTED`, which a walk
cancelled as it reached an expired ancestor reports in place of
`ANCESTOR_EXPIRED`.

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

Defined in: [checkpointer/saver.ts:104](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L104)

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

Throws: `VALIDATION`, before any read, naming `config` for a config that
is not an object, `configurable` for a `configurable` that is present and
not an object, `signal` for a signal that is not `AbortSignal`-shaped, or
`thread_id`, `checkpoint_ns`, `checkpoint_id` or `thread_ts` for a
malformed identifier, and — from a row rather than from the call —
`descriptor` for a payload descriptor no reader could make sense of, `s3`
for an offloaded row with no offloader configured, `s3Key` for a row
addressing an object outside the thread's own path, or `serde` for a
payload the configured serializer refuses to reconstruct;
`FORMAT_UNSUPPORTED` for a row, or a payload, a newer release wrote;
`PAYLOAD_CORRUPT` for a payload that is no longer the form its row
declares; `S3_OFFLOAD_FAILED` for an offloaded payload that cannot be
downloaded; `COMPRESSION_LIMIT` for one whose decompressed size would pass
the cap; a classified AWS failure; `RETRY_EXHAUSTED`; `ABORTED`.

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

Defined in: [checkpointer/saver.ts:147](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L147)

Stream checkpoints newest first.

Accepts: `config` — one namespace, every namespace of a thread when
`checkpoint_ns` is omitted, or every thread in the table when `thread_id`
is omitted, which is a table scan, or a read of the recency index when
`indexName` is set. `options.before`, `options.filter` and
`options.limit` follow the reference savers; `limit: 0` yields nothing,
and a negative one is refused rather than answered with nothing, so that a
page size whose computation went wrong is reported instead of hidden.

Returns: an async generator over the tuples. Abandoning it stops the read,
so a consumer that breaks early pays for no further page.

Throws: `VALIDATION`, raised from the first `.next()`, since a
generator runs none of its body until pulled, and before any read: naming
`config`, `configurable` or `signal` for a config of the wrong shape, as
[getTuple](#gettuple) does, or `thread_id`, `checkpoint_ns`, `checkpoint_id` or
`thread_ts` for a malformed identifier — all checked before `options`;
then `options` for options that are not an object, `options.<key>` for a
key this package does not read, `filter` for a filter that is not an
object, `limit` for a limit that is not an integer from 0 to
`MAX_PAGE_LIMIT` (10,000), and `before` for a `before` that is not an
object or whose `configurable.checkpoint_id` is
neither absent (`undefined`, `null` or `''`) nor a well-formed checkpoint
id. `FORMAT_UNSUPPORTED`; `RESULT_TRUNCATED`, without a `thread_id` and
with `indexName`, for an index shard whose pages do not end; a classified AWS failure;
`RETRY_EXHAUSTED`; `ABORTED`.

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

One read per page — or, without a `thread_id` and with `indexName`,
at least one query per index shard per page of 100 rows — plus two per
yielded tuple (see the README cost table).

#### Overrides

`BaseCheckpointSaver.list`

***

### put()

> **put**(`config`, `checkpoint`, `metadata`, `newVersions?`): `Promise`\<`RunnableConfig`\<`Record`\<`string`, `any`\>\>\>

Defined in: [checkpointer/saver.ts:185](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L185)

Store a checkpoint and its metadata in one transaction.

Accepts: `config` — shaped as [getTuple](#gettuple) requires, and naming a
`thread_id`. `config.configurable.checkpoint_id` — becomes the new
checkpoint's parent. `config.signal` — aborts the write. `checkpoint` —
every channel value it carries is stored. `newVersions` — accepted to
satisfy `BaseCheckpointSaver.put` and deliberately ignored: LangGraph passes
it empty for a fork and for an empty update, so narrowing by it would store
nothing for either (decision record 10).

Returns: the config addressing the stored checkpoint, which is what the
caller passes back to continue the thread.

Throws: `VALIDATION` naming `config`, `configurable` or `signal` for a
config of the wrong shape, `thread_id` for a missing or malformed thread
id, `checkpoint_ns`, `checkpoint_id` or `thread_ts` for a malformed
identifier, `checkpoint` for a `null` or `undefined` checkpoint,
`checkpoint_id` for a malformed `checkpoint.id`, `payload` for a payload
too large to store inline without `s3`, or, once offloaded, larger than
`s3.maxDownloadBytes`; `s3Key` for an offloaded object's key over S3's
cap; `S3_OFFLOAD_FAILED` when an offloaded payload cannot be uploaded;
a classified AWS failure; `RETRY_EXHAUSTED`; `ABORTED`.

Guarantees: both rows land or neither does. Writing the same
`checkpoint.id` again replaces both, so a retry is safe. Each put uploads
its offloaded payloads under an id of its own, so the objects the replaced
rows named are not deleted with them: they are left to the lifecycle rule
`ensureS3LifecycleRule()` provisions.

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

Defined in: [checkpointer/saver.ts:231](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/checkpointer/saver.ts#L231)

Store a task's pending writes for the checkpoint `config` names.

Accepts: `config` — shaped as [getTuple](#gettuple) requires, naming a
`thread_id` and a `checkpoint_id`, since writes attach to a checkpoint.
`config.signal` — aborts the writes. `writes` — an array of
`[channel, value]` arrays, one row each, written in parallel; an empty list
writes nothing. `taskId` — validated as the key segment it becomes.

Returns: nothing. Losing a first-write-wins race is a normal outcome, not
a failure.

Throws: `VALIDATION` naming `taskId` for a malformed task id; `config`,
`configurable` or `signal` for a config of the wrong shape; `thread_id`,
`checkpoint_ns`, `checkpoint_id` or `thread_ts` for a malformed
identifier, and `checkpoint_id` when the config names none; `writes` for
writes that is not an array, or holds an entry that is not one; `channel`
for a malformed channel; `sortKey` for identifiers composing a sort key
over DynamoDB's cap; `payload` for a value too large to store inline
without `s3`, or, once offloaded, larger than `s3.maxDownloadBytes`; or
`s3Key` for an offloaded object's key over S3's cap. `S3_OFFLOAD_FAILED`;
a classified AWS failure; `RETRY_EXHAUSTED`; `ABORTED`.

Guarantees: regular writes are first-write-wins; special channels
(`__interrupt__`, `__resume__`, `__error__`, `__scheduled__`) overwrite,
with `s3` through a compare-and-swap on the row each call observed, so that
each call releases the payload it superseded rather than one a concurrent
call already replaced. An offloaded object can still be orphaned and left
to the lifecycle rule: when the compare-and-swap is exhausted and the write
overwrites unconditionally, when a delete fails, when the row cannot be read
before the write, when a failed write cannot be verified, or in one
double-fault interleaving (see the README's S3 offloading notes).

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
