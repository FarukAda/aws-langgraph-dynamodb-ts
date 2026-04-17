[**AWS LangGraph DynamoDB TypeScript v0.2.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBChatMessageHistory

# Class: DynamoDBChatMessageHistory

Defined in: [history/index.ts:29](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/history/index.ts#L29)

DynamoDB-backed chat message history with per-message-item storage.

## Remarks

Each session is capped at ~999 999 messages by the 6-digit message-index
sort-key padding. Sessions approaching this bound should be sharded by the
caller; see `formatMessageIndex` for details.

## Constructors

### Constructor

> **new DynamoDBChatMessageHistory**(`options`): `DynamoDBChatMessageHistory`

Defined in: [history/index.ts:45](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/history/index.ts#L45)

Create a new DynamoDB chat message history instance

#### Parameters

##### options

[`DynamoDBChatMessageHistoryOptions`](../interfaces/DynamoDBChatMessageHistoryOptions.md)

Configuration options for the chat message history

#### Returns

`DynamoDBChatMessageHistory`

## Methods

### addMessage()

> **addMessage**(`userId`, `sessionId`, `message`, `title?`, `options?`): `Promise`\<`void`\>

Defined in: [history/index.ts:99](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/history/index.ts#L99)

Add a single message to a session
Generates title from the first message if this is a new session

#### Parameters

##### userId

`string`

User identifier

##### sessionId

`string`

Session identifier

##### message

`BaseMessage`

The BaseMessage to add to the session

##### title?

`string`

Optional session title (auto-generated from the first message if not provided)

##### options?

###### signal?

`AbortSignal`

#### Returns

`Promise`\<`void`\>

#### Throws

Error if the operation fails or validation fails

***

### addMessages()

> **addMessages**(`userId`, `sessionId`, `messages`, `title?`, `options?`): `Promise`\<`void`\>

Defined in: [history/index.ts:129](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/history/index.ts#L129)

Add multiple messages to a session
Generates title from the first message if this is a new session
Preferred over calling addMessage multiple times for performance

#### Parameters

##### userId

`string`

User identifier

##### sessionId

`string`

Session identifier

##### messages

`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]

Array of BaseMessage objects to add

##### title?

`string`

Optional session title (auto-generated from the first message if not provided)

##### options?

###### signal?

`AbortSignal`

#### Returns

`Promise`\<`void`\>

#### Throws

Error if the operation fails or validation fails

***

### clear()

> **clear**(`userId`, `sessionId`, `options?`): `Promise`\<`void`\>

Defined in: [history/index.ts:156](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/history/index.ts#L156)

Clear all messages in a session
Deletes the session item from DynamoDB

#### Parameters

##### userId

`string`

User identifier

##### sessionId

`string`

Session identifier

##### options?

###### signal?

`AbortSignal`

#### Returns

`Promise`\<`void`\>

#### Throws

Error if the operation fails or validation fails

***

### destroy()

> **destroy**(): `void`

Defined in: [history/index.ts:60](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/history/index.ts#L60)

Release underlying DynamoDB client resources.
Call this when the history is no longer needed to prevent resource leaks.
Skips cleanup if a shared client was injected via options.

#### Returns

`void`

***

### forSession()

> **forSession**(`userId`, `sessionId`): [`DynamoDBSessionChatMessageHistory`](DynamoDBSessionChatMessageHistory.md)

Defined in: [history/index.ts:208](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/history/index.ts#L208)

Bind this store to a single `(userId, sessionId)` pair and return a
`BaseListChatMessageHistory` compatible instance — the shape LangChain's
`RunnableWithMessageHistory` expects from `getMessageHistory(sessionId)`.

#### Parameters

##### userId

`string`

##### sessionId

`string`

#### Returns

[`DynamoDBSessionChatMessageHistory`](DynamoDBSessionChatMessageHistory.md)

#### Example

```ts
const store = new DynamoDBChatMessageHistory({ tableName });
new RunnableWithMessageHistory({
  runnable,
  getMessageHistory: (sessionId) => store.forSession(userId, sessionId),
  // ...
});
```

***

### getMessages()

> **getMessages**(`userId`, `sessionId`, `options?`): `Promise`\<`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]\>

Defined in: [history/index.ts:75](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/history/index.ts#L75)

Get all messages for a session
Messages are returned in chronological order

#### Parameters

##### userId

`string`

User identifier

##### sessionId

`string`

Session identifier

##### options?

###### signal?

`AbortSignal`

#### Returns

`Promise`\<`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]\>

Array of BaseMessage objects in chronological order

#### Throws

Error if the operation fails or validation fails

***

### listSessions()

> **listSessions**(`userId`, `limit?`, `options?`): `Promise`\<[`SessionMetadata`](../interfaces/SessionMetadata.md)[]\>

Defined in: [history/index.ts:179](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/history/index.ts#L179)

List all sessions for a user, sorted by most recent
Returns metadata only (excludes messages for performance)

#### Parameters

##### userId

`string`

User ID to list sessions for

##### limit?

`number`

Optional maximum number of sessions to return (default: no limit)

##### options?

###### signal?

`AbortSignal`

#### Returns

`Promise`\<[`SessionMetadata`](../interfaces/SessionMetadata.md)[]\>

Array of session metadata, sorted by most recent first

#### Throws

Error if the operation fails or validation fails
