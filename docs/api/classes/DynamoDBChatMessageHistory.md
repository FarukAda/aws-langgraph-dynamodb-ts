[**AWS LangGraph DynamoDB TypeScript v0.9.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBChatMessageHistory

# Class: DynamoDBChatMessageHistory

Defined in: [history/chat-message-history.ts:20](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/c3f018f37290d04fc34b7157d4ff279f0567c7f1/src/history/chat-message-history.ts#L20)

DynamoDB-backed multi-session chat history. Each message is its own item
(ordered by a monotonic ULID, compressed / S3-offloaded as needed) alongside a
per-session metadata item; every message in a session shares one uniform TTL.
Appends are O(1) and lock-free. Use [forSession](#forsession) to get a single-session
LangChain adapter.

## Constructors

### Constructor

> **new DynamoDBChatMessageHistory**(`options`): `DynamoDBChatMessageHistory`

Defined in: [history/chat-message-history.ts:25](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/c3f018f37290d04fc34b7157d4ff279f0567c7f1/src/history/chat-message-history.ts#L25)

#### Parameters

##### options

[`DynamoDBChatMessageHistoryOptions`](../type-aliases/DynamoDBChatMessageHistoryOptions.md)

#### Returns

`DynamoDBChatMessageHistory`

## Methods

### addMessage()

> **addMessage**(`sessionId`, `message`): `Promise`\<`void`\>

Defined in: [history/chat-message-history.ts:43](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/c3f018f37290d04fc34b7157d4ff279f0567c7f1/src/history/chat-message-history.ts#L43)

Append a single message to a session.

#### Parameters

##### sessionId

`string`

##### message

`BaseMessage`

#### Returns

`Promise`\<`void`\>

***

### addMessages()

> **addMessages**(`sessionId`, `messages`): `Promise`\<`void`\>

Defined in: [history/chat-message-history.ts:38](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/c3f018f37290d04fc34b7157d4ff279f0567c7f1/src/history/chat-message-history.ts#L38)

Append messages to a session.

#### Parameters

##### sessionId

`string`

##### messages

`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]

#### Returns

`Promise`\<`void`\>

***

### clear()

> **clear**(`sessionId`): `Promise`\<`void`\>

Defined in: [history/chat-message-history.ts:48](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/c3f018f37290d04fc34b7157d4ff279f0567c7f1/src/history/chat-message-history.ts#L48)

Delete a session and any offloaded payload.

#### Parameters

##### sessionId

`string`

#### Returns

`Promise`\<`void`\>

***

### destroy()

> **destroy**(): `void`

Defined in: [history/chat-message-history.ts:74](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/c3f018f37290d04fc34b7157d4ff279f0567c7f1/src/history/chat-message-history.ts#L74)

Release owned resources (the underlying client and any S3 client).

#### Returns

`void`

***

### ensureS3LifecycleRule()

> **ensureS3LifecycleRule**(): `Promise`\<`void`\>

Defined in: [history/chat-message-history.ts:87](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/c3f018f37290d04fc34b7157d4ff279f0567c7f1/src/history/chat-message-history.ts#L87)

Best-effort provision an S3 lifecycle expiration rule matching the
configured TTL, so offloaded objects don't outlive their DynamoDB item
forever. No-ops when S3 offload or TTL isn't configured. Requires the
`s3:GetLifecycleConfiguration`/`s3:PutLifecycleConfiguration` bucket-level
permissions (broader than the object-level CRUD the rest of S3 offload
needs) — call this once during deployment/provisioning, not per-request.

#### Returns

`Promise`\<`void`\>

***

### forSession()

> **forSession**(`sessionId`): [`DynamoDBSessionChatMessageHistory`](DynamoDBSessionChatMessageHistory.md)

Defined in: [history/chat-message-history.ts:69](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/c3f018f37290d04fc34b7157d4ff279f0567c7f1/src/history/chat-message-history.ts#L69)

Get a single-session LangChain adapter for `sessionId`.

#### Parameters

##### sessionId

`string`

#### Returns

[`DynamoDBSessionChatMessageHistory`](DynamoDBSessionChatMessageHistory.md)

***

### getMessages()

> **getMessages**(`sessionId`): `Promise`\<`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]\>

Defined in: [history/chat-message-history.ts:33](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/c3f018f37290d04fc34b7157d4ff279f0567c7f1/src/history/chat-message-history.ts#L33)

Get a session's messages in order.

#### Parameters

##### sessionId

`string`

#### Returns

`Promise`\<`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]\>

***

### listSessions()

> **listSessions**(`options?`): `Promise`\<[`SessionMetadata`](../interfaces/SessionMetadata.md)[]\>

Defined in: [history/chat-message-history.ts:53](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/c3f018f37290d04fc34b7157d4ff279f0567c7f1/src/history/chat-message-history.ts#L53)

List all sessions as metadata summaries.

#### Parameters

##### options?

###### maxItems?

`number`

###### maxIterations?

`number`

#### Returns

`Promise`\<[`SessionMetadata`](../interfaces/SessionMetadata.md)[]\>

***

### reconcileMessageCount()

> **reconcileMessageCount**(`sessionId`): `Promise`\<`number`\>

Defined in: [history/chat-message-history.ts:64](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/c3f018f37290d04fc34b7157d4ff279f0567c7f1/src/history/chat-message-history.ts#L64)

Recompute and repair a session's `messageCount` from the stored messages.
A maintenance tool for external corruption; run it when the session is idle.

#### Parameters

##### sessionId

`string`

#### Returns

`Promise`\<`number`\>
