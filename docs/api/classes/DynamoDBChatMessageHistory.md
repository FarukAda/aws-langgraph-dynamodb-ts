[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBChatMessageHistory

# Class: DynamoDBChatMessageHistory

Defined in: [history/chat-message-history.ts:42](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L42)

DynamoDB-backed multi-session chat history. Each message is its own row,
ordered by when it was appended, beside one metadata row per session, and
every message in a session shares one TTL. An append costs the same however
long the session is and takes no lock. Use [forSession](#forsession) to get a
single-session LangChain adapter. Every public method rejects only with this
library's error.

## Constructors

### Constructor

> **new DynamoDBChatMessageHistory**(`options`): `DynamoDBChatMessageHistory`

Defined in: [history/chat-message-history.ts:57](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L57)

Accepts: `options` — validated here, so a misconfiguration surfaces at
construction rather than on the first request.

Returns: an adapter that owns the client it built, or borrows the one it
was given.

Throws: `VALIDATION` naming the offending option.

Guarantees: no I/O. Constructing the adapter issues no request.

#### Parameters

##### options

[`DynamoDBChatMessageHistoryOptions`](../type-aliases/DynamoDBChatMessageHistoryOptions.md)

#### Returns

`DynamoDBChatMessageHistory`

## Methods

### addMessage()

> **addMessage**(`sessionId`, `message`, `options?`): `Promise`\<`void`\>

Defined in: [history/chat-message-history.ts:144](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L144)

Append one message.

Accepts: as [addMessages](#addmessages), for a single message.

Returns: nothing.

Throws: as [addMessages](#addmessages).

#### Parameters

##### sessionId

`string`

##### message

`BaseMessage`

##### options?

[`CancelOptions`](../interfaces/CancelOptions.md)

#### Returns

`Promise`\<`void`\>

***

### addMessages()

> **addMessages**(`sessionId`, `messages`, `options?`): `Promise`\<`void`\>

Defined in: [history/chat-message-history.ts:128](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L128)

Append messages to a session.

Accepts: `sessionId` — validated. `messages` — LangChain messages; an empty
list writes nothing and is not an error. `options.signal` — aborts between
chunks.

Returns: nothing, and only once every message has landed.

Throws: `VALIDATION` naming `messages`, for a value that is not itself
an array, or, with the offending index, for an element that is not a
message or one that could never be read back; naming `payload` for a
message too large to store inline without `s3`, or, once offloaded,
larger than `s3.maxDownloadBytes`; or naming `signal` or
`options.<key>` for a key this package does not read;
`COMPENSATION_FAILED` when a chunk fails and either the rollback fails
too or that chunk's own outcome could not be established;
`RETRY_EXHAUSTED` after 18 contended attempts; a classified AWS failure;
`ABORTED`.

Guarantees: a caller observes all messages or none — except the one
chunk a failed call could not settle: an `ABORTED` append whose in-flight
chunk commits after the call returns, or a `COMPENSATION_FAILED` append
whose failing chunk's own outcome could not be established. Read the
session back before deciding whether to resend those messages. One
transaction per chunk of up to 99 keeps `messageCount` exact. Lock-free
and safe under concurrent appends to one session; every message shares
the session's TTL when one is configured.

#### Parameters

##### sessionId

`string`

##### messages

`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]

##### options?

[`CancelOptions`](../interfaces/CancelOptions.md)

#### Returns

`Promise`\<`void`\>

***

### clear()

> **clear**(`sessionId`, `options?`): `Promise`\<`void`\>

Defined in: [history/chat-message-history.ts:175](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L175)

Delete a session's messages, metadata and offloaded objects.

Accepts: `sessionId` — validated. `options.signal` — aborts between pages.

Returns: nothing. Clearing a session that does not exist is not an error.

Throws: `VALIDATION` for a malformed session id, an invalid `signal`,
or an `options.<key>` this package does not read;
`BATCH_WRITE_INCOMPLETE` when a row's delete fails, counting rows
rather than batches; a classified AWS failure; `ABORTED` when the signal fires,
which is what a cancel surfaces as rather than an incomplete delete, even
when it fires part-way through the pass. A row refused because it
was rewritten after the partition read raises nothing: it is left in place,
reported at `warn`, and counted as skipped.

Guarantees: a row this adapter did not write is left in place and logged,
and neither is a row rewritten since the read — an append landing during
the call moves the session row's own write id, so that row survives with
the session it belongs to instead of being removed under a live
conversation. Single pass: call it when the session is quiescent, since a
message appended while it runs may survive it, and the surviving session
row then over-counts until `reconcileMessageCount` repairs it.

#### Parameters

##### sessionId

`string`

##### options?

[`CancelOptions`](../interfaces/CancelOptions.md)

#### Returns

`Promise`\<`void`\>

***

### destroy()

> **destroy**(): `void`

Defined in: [history/chat-message-history.ts:284](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L284)

Release owned resources.

Accepts: nothing.

Returns: nothing. Idempotent, and a no-op for a client the caller injected
— that one is theirs to close.

Throws: whatever a resource's own `destroy` raises — but only after every
other one has been released, so a client that fails to close never strands
the one behind it.

#### Returns

`void`

***

### ensureS3LifecycleRule()

> **ensureS3LifecycleRule**(): `Promise`\<`void`\>

Defined in: [history/chat-message-history.ts:304](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L304)

Provision an S3 lifecycle expiration rule matching the configured TTL, so
offloaded objects don't outlive their DynamoDB item forever.

Accepts: nothing; the rule follows the configured `s3` and `ttl`. A no-op
without both.

Returns: nothing. Installing a rule that is already there is a no-op too.

Throws: `VALIDATION` naming `s3.keyPrefix` on a rule-id collision;
a classified AWS failure when the bucket's lifecycle cannot be read or written.

#### Returns

`Promise`\<`void`\>

#### Remarks

Requires the bucket-level `s3:GetLifecycleConfiguration` /
`s3:PutLifecycleConfiguration` permissions, broader than the object-level
CRUD the rest of S3 offload needs — call it once during provisioning, not
per request.

***

### forSession()

> **forSession**(`sessionId`, `window?`): [`DynamoDBSessionChatMessageHistory`](DynamoDBSessionChatMessageHistory.md)

Defined in: [history/chat-message-history.ts:268](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L268)

Get a single-session LangChain adapter for `sessionId`.

Accepts: `sessionId` — validated by the adapter's own constructor, the
same rule every other method applies. `window.limit` — bounds what the
adapter feeds the chain to the newest that many messages; validated the
same way.

Returns: an adapter implementing `BaseListChatMessageHistory`, which is
what `RunnableWithMessageHistory` takes.

Throws: `VALIDATION` naming `sessionId`, `window` for a window that is
not an object, `window.<key>` for a key the adapter does not declare, or
`limit` — raised by the constructed adapter, so a bad id or window fails
here rather than on first use.

#### Parameters

##### sessionId

`string`

##### window?

[`AdapterWindow`](../type-aliases/AdapterWindow.md)

#### Returns

[`DynamoDBSessionChatMessageHistory`](DynamoDBSessionChatMessageHistory.md)

***

### getMessages()

> **getMessages**(`sessionId`, `options?`): `Promise`\<`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]\>

Defined in: [history/chat-message-history.ts:93](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L93)

Get a session's messages in chronological order.

Accepts: `sessionId` — validated. `options.limit` — an integer from 1 to
`MAX_PAGE_LIMIT` (10,000); only the newest that many messages. `0` is
refused rather than answered with an empty conversation, which is the one
place this package refuses a `limit` of zero. `options.before` — a valid
`Date`; only messages appended before that instant. Neither given reads
the whole session. `options.signal` — aborts the reads.

Returns: the messages, oldest first. A session that does not exist and one
whose messages have all expired both return nothing.

Throws: `VALIDATION` for a malformed session id or window, an invalid
`signal`, or naming `options.<key>` for a key this package does not read;
`VALIDATION` naming `s3Key` for a row addressing an object outside the
session's own path, and naming `message` for a row in this session's
message key space that this adapter did not write, both whatever the
corruption policy;
`COMPRESSION_LIMIT` for a payload larger than this reader's
`compression.maxDecompressedBytes`, whatever the corruption policy too;
`FORMAT_UNSUPPORTED` for a row, or a payload, a newer release wrote;
a classified AWS failure;
`ABORTED`; and, under `onCorruptMessage: 'throw'`, the decode error of a
corrupt row.

Guarantees: strongly consistent, so the turn just appended is visible.
Expired messages are filtered on read, so the history is never stale.

#### Parameters

##### sessionId

`string`

##### options?

[`GetMessagesOptions`](../type-aliases/GetMessagesOptions.md)

#### Returns

`Promise`\<`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]\>

#### Remarks

One query page plus one S3 download per offloaded message.

***

### listSessions()

> **listSessions**(`options?`): `Promise`\<[`SessionPage`](../interfaces/SessionPage.md)\>

Defined in: [history/chat-message-history.ts:218](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L218)

List every session as a metadata summary, most recently updated first.
With a configured `indexName` this reads each index shard newest-first,
merges the shards and pages by the opaque `nextCursor`. Without one it
falls back to a filtered table scan — cross-tenant by construction,
bounded by `maxItems` / `maxIterations`, and returning the newest `limit`
sessions, or every session when no limit is given, with no cursor.

Accepts: `options.limit` — an integer from 0 to `MAX_PAGE_LIMIT` (10,000);
the page size with the index, the newest N without it, and `0` an empty
page read from neither. `options.cursor` — from a previous page,
and only with a configured `indexName`. `options.maxItems` /
`maxIterations` — caps on the scan path. `options.signal` — aborts the
reads.

Returns: the page and, while rows may remain, a `nextCursor`. A page may
come back shorter than `limit` while more rows remain: expired and foreign
rows are dropped after the read. A cursor does not promise more rows:
DynamoDB can end a shard's page at its last row and still return a key to
continue from, and the page after such a cursor can come back empty. Stop
when `nextCursor` is absent, never when a page looks short.

Throws: `VALIDATION` naming `limit`, `cursor`, `maxItems`,
`maxIterations`, `signal`, or `options.<key>` for a key this package does
not read; `RESULT_TRUNCATED` past either cap on the scan path, or for an
index shard whose pages do not end; `FORMAT_UNSUPPORTED` for a session row
a newer release wrote; a classified AWS failure; `ABORTED`.

Guarantees: with a configured `indexName` each shard is read one DynamoDB
page at a time, and its next page whenever it has no row buffered and the
page still needs one, so a shard can cost a query whose rows the page never
takes; at most `readConcurrency` shards are queried at once. Memory is the
page being built, up to `limit` rows and so bounded by
`MAX_PAGE_LIMIT` (10,000), plus at most one DynamoDB page per shard,
whatever the table holds.

#### Parameters

##### options?

[`ListSessionsOptions`](../interfaces/ListSessionsOptions.md)

#### Returns

`Promise`\<[`SessionPage`](../interfaces/SessionPage.md)\>

***

### reconcileMessageCount()

> **reconcileMessageCount**(`sessionId`, `options?`): `Promise`\<`number`\>

Defined in: [history/chat-message-history.ts:245](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L245)

Recompute and repair a session's `messageCount` from the stored messages.
A maintenance tool for external corruption; run it when the session is idle.

Accepts: `sessionId` — validated, and an existing session.
`options.signal` — aborts the reads.

Returns: the count now stored, which is the number of messages a reader
would see.

Throws: `VALIDATION` for a malformed session id, an invalid `signal`,
or an `options.<key>` this package does not read; `CONDITION_CONFLICT` when the
session does not exist or stayed busy through every attempt;
`FORMAT_UNSUPPORTED` for a message row a newer release wrote, and
`VALIDATION` naming `message` for a row in the session's message key
space that this adapter did not write, both of which `getMessages` refuses
too — a count is a repair only while it agrees with the read;
a classified AWS failure; `ABORTED`.

Guarantees: safe on a live session — the write is pinned to the value the
row held when the count was computed, so a concurrent append makes it
recount instead of clobbering the increment.

#### Parameters

##### sessionId

`string`

##### options?

[`CancelOptions`](../interfaces/CancelOptions.md)

#### Returns

`Promise`\<`number`\>
