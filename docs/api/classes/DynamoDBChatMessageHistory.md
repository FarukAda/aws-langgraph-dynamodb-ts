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

Defined in: [history/chat-message-history.ts:33](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L33)

#### Parameters

##### options

[`DynamoDBChatMessageHistoryOptions`](../type-aliases/DynamoDBChatMessageHistoryOptions.md)

#### Returns

`DynamoDBChatMessageHistory`

## Methods

### addMessage()

> **addMessage**(`sessionId`, `message`, `options?`): `Promise`\<`void`\>

Defined in: [history/chat-message-history.ts:68](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L68)

Append one message; see [addMessages](#addmessages).

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

Defined in: [history/chat-message-history.ts:61](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L61)

Append messages to a session in one transaction per chunk of up to 99
messages, keeping the session's `messageCount` exact. Lock-free and safe
under concurrent appends to one session; every message shares the
session's TTL when one is configured.

#### Parameters

##### sessionId

`string`

##### messages

`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]

##### options?

[`CancelOptions`](../interfaces/CancelOptions.md)

#### Returns

`Promise`\<`void`\>

#### Throws

ValidationError for a message that could never be read back; CompensationFailedError when a later chunk fails and the rollback fails too; RetryExhaustedError after 18 contended attempts; UpstreamError; AbortError.

***

### clear()

> **clear**(`sessionId`, `options?`): `Promise`\<`void`\>

Defined in: [history/chat-message-history.ts:79](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L79)

Delete a session's messages, metadata and offloaded objects. Single pass:
call it when the session is quiescent.

#### Parameters

##### sessionId

`string`

##### options?

[`CancelOptions`](../interfaces/CancelOptions.md)

#### Returns

`Promise`\<`void`\>

#### Throws

BatchWriteAllIncompleteError when a delete batch does not fully drain; UpstreamError; AbortError.

***

### destroy()

> **destroy**(): `void`

Defined in: [history/chat-message-history.ts:113](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L113)

Release owned resources (the underlying client and any S3 client).

#### Returns

`void`

***

### ensureS3LifecycleRule()

> **ensureS3LifecycleRule**(): `Promise`\<`void`\>

Defined in: [history/chat-message-history.ts:127](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L127)

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

### forSession()

> **forSession**(`sessionId`, `window?`): [`DynamoDBSessionChatMessageHistory`](DynamoDBSessionChatMessageHistory.md)

Defined in: [history/chat-message-history.ts:108](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L108)

Get a single-session LangChain adapter for `sessionId`. `{ limit }` bounds
what the adapter feeds the chain to the newest `limit` messages.

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

Defined in: [history/chat-message-history.ts:48](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L48)

Get a session's messages in chronological order: the whole session by
default, or a window of it — `{ limit }` returns only the newest `limit`
messages, `{ before }` only those appended before that instant — so a
long-lived session can be read a page at a time instead of whole.

#### Parameters

##### sessionId

`string`

##### options?

[`GetMessagesOptions`](../type-aliases/GetMessagesOptions.md)

#### Returns

`Promise`\<`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]\>

#### Remarks

Strongly consistent; one query page plus one S3 download per offloaded message.

#### Throws

ValidationError for a malformed session id or window; UpstreamError; AbortError; and, under `onCorruptMessage: 'throw'`, the decode error of a corrupt row.

***

### listSessions()

> **listSessions**(`options?`): `Promise`\<[`SessionMetadata`](../interfaces/SessionMetadata.md)[]\>

Defined in: [history/chat-message-history.ts:89](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L89)

List every session as a metadata summary, most recently updated first.
A table scan: cross-tenant by construction and bounded by `maxItems` /
`maxIterations`.

#### Parameters

##### options?

[`ListSessionsOptions`](../interfaces/ListSessionsOptions.md)

#### Returns

`Promise`\<[`SessionMetadata`](../interfaces/SessionMetadata.md)[]\>

#### Throws

ResultTruncatedError past either cap; UpstreamError; AbortError.

***

### reconcileMessageCount()

> **reconcileMessageCount**(`sessionId`, `options?`): `Promise`\<`number`\>

Defined in: [history/chat-message-history.ts:98](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/chat-message-history.ts#L98)

Recompute and repair a session's `messageCount` from the stored messages.
A maintenance tool for external corruption; run it when the session is idle.

#### Parameters

##### sessionId

`string`

##### options?

[`CancelOptions`](../interfaces/CancelOptions.md)

#### Returns

`Promise`\<`number`\>

#### Throws

ConflictError when the session does not exist or changed while counting; UpstreamError; AbortError.
