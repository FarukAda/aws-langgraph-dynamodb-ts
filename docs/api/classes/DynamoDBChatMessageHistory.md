[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBChatMessageHistory

# Class: DynamoDBChatMessageHistory

Defined in: [history/chat-message-history.ts:28](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L28)

DynamoDB-backed multi-session chat history. Each message is its own item
(ordered by a monotonic ULID, compressed / S3-offloaded as needed) alongside a
per-session metadata item; every message in a session shares one uniform TTL.
Appends are O(1) and lock-free. Use [forSession](#forsession) to get a single-session
LangChain adapter. Every public method is the library's error boundary — a
raw AWS SDK error escaping an action surfaces as an `UpstreamError`.

## Constructors

### Constructor

> **new DynamoDBChatMessageHistory**(`options`): `DynamoDBChatMessageHistory`

Defined in: [history/chat-message-history.ts:44](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L44)

Accepts: `options` — validated here, so a misconfiguration surfaces at
construction rather than on the first request.

Returns: an adapter that owns the client it built, or borrows the one it
was given.

Throws: ValidationError naming the offending option.

Guarantees: no I/O. Constructing the adapter issues no request.

#### Parameters

##### options

[`DynamoDBChatMessageHistoryOptions`](../type-aliases/DynamoDBChatMessageHistoryOptions.md)

#### Returns

`DynamoDBChatMessageHistory`

## Methods

### addMessage()

> **addMessage**(`sessionId`, `message`, `options?`): `Promise`\<`void`\>

Defined in: [history/chat-message-history.ts:112](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L112)

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

Defined in: [history/chat-message-history.ts:97](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L97)

Append messages to a session.

Accepts: `sessionId` — validated. `messages` — LangChain messages; an empty
list writes nothing and is not an error. `options.signal` — aborts between
chunks.

Returns: nothing, and only once every message has landed.

Throws: ValidationError naming `messages` with the offending index, for a
value that is not a message or one that could never be read back;
CompensationFailedError when a later chunk fails and the rollback fails
too; RetryExhaustedError after 18 contended attempts; UpstreamError;
AbortError.

Guarantees: a caller observes all messages or none. One transaction per
chunk of up to 99 keeps `messageCount` exact. Lock-free and safe under
concurrent appends to one session; every message shares the session's TTL
when one is configured.

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

Defined in: [history/chat-message-history.ts:133](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L133)

Delete a session's messages, metadata and offloaded objects.

Accepts: `sessionId` — validated. `options.signal` — aborts between pages.

Returns: nothing. Clearing a session that does not exist is not an error.

Throws: ValidationError for a malformed session id;
BatchWriteAllIncompleteError when a delete batch does not fully drain;
UpstreamError; AbortError.

Guarantees: a row this adapter did not write is left in place and logged.
Single pass: call it when the session is quiescent, since a message
appended while it runs may survive it.

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

Defined in: [history/chat-message-history.ts:217](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L217)

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

Defined in: [history/chat-message-history.ts:238](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L238)

Provision an S3 lifecycle expiration rule matching the configured TTL, so
offloaded objects don't outlive their DynamoDB item forever.

Accepts: nothing; the rule follows the configured `s3` and `ttl`. A no-op
without both.

Returns: nothing. Installing a rule that is already there is a no-op too.

Throws: ValidationError naming `s3.keyPrefix` on a rule-id collision;
UpstreamError when the bucket's lifecycle cannot be read or written.

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

Defined in: [history/chat-message-history.ts:203](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L203)

Get a single-session LangChain adapter for `sessionId`.

Accepts: `sessionId` — not validated here; the adapter's own calls validate
it, so a bad id fails at the operation rather than at the handle.
`window.limit` — bounds what the adapter feeds the chain to the newest that
many messages.

Returns: an adapter implementing `BaseListChatMessageHistory`, which is
what `RunnableWithMessageHistory` takes.

Throws: nothing; it opens nothing and reads nothing.

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

Defined in: [history/chat-message-history.ts:71](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L71)

Get a session's messages in chronological order.

Accepts: `sessionId` — validated. `options.limit` — a positive integer;
only the newest that many messages. `options.before` — a valid `Date`; only
messages appended before that instant. Neither given reads the whole
session. `options.signal` — aborts the reads.

Returns: the messages, oldest first. A session that does not exist and one
whose messages have all expired both return nothing.

Throws: ValidationError for a malformed session id or window;
`FORMAT_UNSUPPORTED` for a row a newer release wrote; UpstreamError;
AbortError; and, under `onCorruptMessage: 'throw'`, the decode error of a
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

Defined in: [history/chat-message-history.ts:162](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L162)

List every session as a metadata summary, most recently updated first.
With a configured `indexName` this is a bounded query per index shard,
merged newest-first and paged by the opaque `nextCursor`. Without one it
falls back to a filtered table scan — cross-tenant by construction,
bounded by `maxItems` / `maxIterations`, and returning the newest `limit`
sessions, or every session when no limit is given, with no cursor.

Accepts: `options.limit` — a positive integer; the page size with the
index, the newest N without it. `options.cursor` — from a previous page,
and only with a configured `indexName`. `options.maxItems` /
`maxIterations` — caps on the scan path. `options.signal` — aborts the
reads.

Returns: the page and, when more rows remain, a `nextCursor`. A page may
come back shorter than `limit` while more rows remain: expired and foreign
rows are dropped after the read. Stop when `nextCursor` is absent, never
when a page looks short.

Throws: ValidationError naming `limit` or `cursor`; ResultTruncatedError
past either cap on the scan path; UpstreamError; AbortError.

Guarantees: with a configured `indexName` the cost is one bounded query per
index shard, whatever the table holds.

#### Parameters

##### options?

[`ListSessionsOptions`](../interfaces/ListSessionsOptions.md)

#### Returns

`Promise`\<[`SessionPage`](../interfaces/SessionPage.md)\>

***

### reconcileMessageCount()

> **reconcileMessageCount**(`sessionId`, `options?`): `Promise`\<`number`\>

Defined in: [history/chat-message-history.ts:184](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L184)

Recompute and repair a session's `messageCount` from the stored messages.
A maintenance tool for external corruption; run it when the session is idle.

Accepts: `sessionId` — validated, and an existing session.
`options.signal` — aborts the reads.

Returns: the count now stored, which is the number of messages a reader
would see.

Throws: ValidationError for a malformed session id; ConflictError when the
session does not exist or stayed busy through every attempt; UpstreamError;
AbortError.

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
